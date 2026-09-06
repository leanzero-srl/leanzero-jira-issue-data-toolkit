const fs = require("fs");
const path = require("path");

class TrafficLightProcessor {
  constructor(datacenterClient, cloudJiraClient, planManager, options = {}) {
    this.dcClient = datacenterClient;
    this.cloudJiraClient = cloudJiraClient;
    this.planManager = planManager;
    this.dryRun = options.dryRun || false;
    this.limit = options.limit || 0;
    this.concurrency = options.concurrency || 10;
    this.retryFailed = options.retryFailed || false;
    this.force = options.force || false;
    this.log = options.log || console.log;

    // Load field mappings config
    this.fieldMappings = this._loadFieldMappings(options.configPath);

    if (options.fieldName) {
      const target = options.fieldName.toLowerCase();
      this.fieldMappings = this.fieldMappings.filter(
        (f) => f.name.toLowerCase() === target,
      );
      if (this.fieldMappings.length === 0) {
        throw new Error(
          `Field "${options.fieldName}" not found in field_mappings.json`,
        );
      }
    }

    // Stats
    this.stats = {
      fieldsChecked: 0,
      fieldsSkipped: 0,
      fieldsMatched: 0,
      issuesProcessed: 0,
      issuesUpdated: 0,
      issuesFailed: 0,
      issuesSkipped: 0,
      issuesAlreadyInSync: 0,
      unmappedValues: [],
    };
  }

  _loadFieldMappings(configPath) {
    const cfgPath = configPath || path.resolve(__dirname, "../config/field_mappings.json");
    if (!fs.existsSync(cfgPath)) {
      throw new Error(`Field mappings config not found: ${cfgPath}`);
    }
    const data = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return data.fields || [];
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1: BUILD PLANS
  // ─────────────────────────────────────────────────

  async buildPlans(runId) {
    this.log(`\nBuilding plans for ${this.fieldMappings.length} traffic light fields...`);

    this.planManager.createMasterIndex(runId);

    for (let i = 0; i < this.fieldMappings.length; i++) {
      const fieldConfig = this.fieldMappings[i];
      this.log(`\n[${i + 1}/${this.fieldMappings.length}] Scanning field: "${fieldConfig.name}" (DC: ${fieldConfig.dcFieldId})`);

      try {
        await this._buildFieldPlan(fieldConfig, runId);
      } catch (error) {
        this.log(`  ERROR building plan for "${fieldConfig.name}": ${error.message}`);
        if (error.stack) this.log(`  ${error.stack}`);
        this.stats.fieldsSkipped++;
        this.planManager.addFieldToMasterIndex(
          fieldConfig.name, fieldConfig.dcFieldId, fieldConfig.cloudFieldId, null, 0,
          { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0 },
        );
        continue;
      }
      this.stats.fieldsChecked++;
    }

    this.log(`\nAll plans built. Master index: ${this.planManager.masterIndexPath}`);
    this.log(`Master stats: ${this.planManager.masterIndex.stats.totalFields} fields, ${this.planManager.masterIndex.stats.totalIssues} total issues`);

    // Report unmapped values
    if (this.stats.unmappedValues.length > 0) {
      this.log(`\n  WARNING: ${this.stats.unmappedValues.length} unmapped DC values found:`);
      for (const { fieldName, dcValue } of this.stats.unmappedValues) {
        this.log(`    "${fieldName}": "${dcValue}"`);
      }
      this.log(`  Add these to config/field_mappings.json before executing.`);
    }

    return this.planManager.masterIndex;
  }

  async _buildFieldPlan(fieldConfig, runId) {
    this.stats.fieldsMatched++;

    // Build a lookup map: DC label (lowercased) -> { shape, label }
    const optionsByLabel = new Map();
    for (const opt of fieldConfig.options) {
      optionsByLabel.set(opt.label.toLowerCase(), opt);
    }

    // Scan DC issues for this field
    const issuesMap = {};
    let totalTickets = 0;
    let ticketLimitReached = false;

    this.log(`  Scanning DC tickets for field "${fieldConfig.name}" (${fieldConfig.dcFieldId})...`);
    await this.dcClient.searchTicketsForField(fieldConfig.dcFieldId, async (pageTickets) => {
      if (ticketLimitReached) return false;

      let ticketsToProcess = pageTickets;
      if (this.limit > 0) {
        const remaining = this.limit - totalTickets;
        if (remaining <= 0) {
          ticketLimitReached = true;
          return false;
        }
        ticketsToProcess = pageTickets.slice(0, remaining);
      }

      for (const ticket of ticketsToProcess) {
        const dcRaw = this._extractDcValue(ticket.fieldValue);
        if (!dcRaw) continue;

        // Map DC value to Cloud value
        const cloudValue = this._mapDcToCloud(dcRaw, optionsByLabel, fieldConfig.name);
        if (!cloudValue) continue; // unmapped — already logged

        issuesMap[ticket.key] = {
          status: "pending",
          dcRaw,
          cloudValue,
          error: null,
        };
      }

      totalTickets += ticketsToProcess.length;
      this.log(`    ... ${totalTickets} DC tickets fetched (${Object.keys(issuesMap).length} with values)`);
      if (this.limit > 0 && totalTickets >= this.limit) {
        ticketLimitReached = true;
        return false;
      }
    });

    const issueCount = Object.keys(issuesMap).length;
    this.log(`  ${totalTickets} DC tickets scanned, ${issueCount} have traffic light values`);

    if (issueCount === 0) {
      this.planManager.addFieldToMasterIndex(
        fieldConfig.name, fieldConfig.dcFieldId, fieldConfig.cloudFieldId, null, 0,
        { total: 0, pending: 0, completed: 0, failed: 0, skipped: 0 },
      );
      return;
    }

    // Batch-check Cloud state to skip issues already in sync (skipped in force mode)
    let skippedInSync = 0;
    if (this.force) {
      this.log(`  FORCE mode: skipping in-sync check — all ${issueCount} issues will be overwritten`);
    } else {
      this.log(`  Checking Cloud state for ${issueCount} tickets...`);
      const issueKeys = Object.keys(issuesMap);
      const cloudFieldValues = await this.cloudJiraClient.searchIssuesByKeys(
        issueKeys,
        [fieldConfig.cloudFieldId],
      );
      this.log(`  Cloud returned data for ${cloudFieldValues.size}/${issueKeys.length} issues`);

      for (const [issueKey, issueData] of Object.entries(issuesMap)) {
        const cloudFields = cloudFieldValues.get(issueKey);
        if (cloudFields) {
          const currentValue = cloudFields[fieldConfig.cloudFieldId];
          if (currentValue && this._valuesMatch(currentValue, issueData.cloudValue)) {
            issueData.status = "skipped";
            issueData.error = "Already in sync";
            skippedInSync++;
          }
        }
      }

      this.log(`  ${issueCount - skippedInSync} issues need changes, ${skippedInSync} already in sync`);
    }

    // Save per-field plan
    const { planFile, plan } = this.planManager.createFieldPlan(runId, fieldConfig, issuesMap);
    this.log(`  Field plan saved: ${planFile} (${plan.stats.total} issues, ${plan.stats.pending} pending)`);

    this.planManager.addFieldToMasterIndex(
      fieldConfig.name, fieldConfig.dcFieldId, fieldConfig.cloudFieldId,
      planFile, plan.stats.total, plan.stats,
    );
  }

  /**
   * Extract the display value string from a DC traffic light field value.
   * DC returns: { value: "(,,red) Red", id: "28343" } or just a string.
   */
  _extractDcValue(fieldValue) {
    if (!fieldValue) return null;

    if (typeof fieldValue === "object" && fieldValue.value) {
      return fieldValue.value;
    }
    if (typeof fieldValue === "string") {
      return fieldValue;
    }

    return null;
  }

  /**
   * Map a DC value string like "(,,red) Red" to a Cloud {shape, label} object.
   * Strategy: extract the label portion from the DC string, match it against Cloud options.
   *
   * DC format examples:
   *   "(,,red) Red"          -> label = "Red"
   *   "(red,yellow,) red-yellow" -> label = "red-yellow"
   *   "(,yellow,) yellow"    -> label = "yellow"
   *   "(green,,) green"      -> label = "green"
   *   "(,,) Chartreuse"      -> label = "Chartreuse"
   */
  _mapDcToCloud(dcRaw, optionsByLabel, fieldName) {
    // Extract label: everything after the first ") " (closing paren + space)
    let label = dcRaw;
    const parenEnd = dcRaw.indexOf(") ");
    if (parenEnd !== -1) {
      label = dcRaw.substring(parenEnd + 2).trim();
    } else if (dcRaw.startsWith("(") && dcRaw.endsWith(")")) {
      // Edge case: value is just "(something)" with no label
      label = dcRaw;
    }

    if (!label) return null;

    const cloudOption = optionsByLabel.get(label.toLowerCase());
    if (cloudOption) {
      return { shape: cloudOption.shape, label: cloudOption.label };
    }

    // Not found — record as unmapped
    this.stats.unmappedValues.push({ fieldName, dcValue: dcRaw });
    return null;
  }

  /**
   * Check if a Cloud field value matches the desired {shape, label}.
   */
  _valuesMatch(cloudCurrent, desired) {
    if (!cloudCurrent || !desired) return false;

    // Cloud may return the value directly as {shape, label}
    if (cloudCurrent.shape && cloudCurrent.label) {
      return cloudCurrent.shape === desired.shape && cloudCurrent.label === desired.label;
    }

    // Cloud may return as {value: {shape, label}} or nested
    if (cloudCurrent.value) {
      return this._valuesMatch(cloudCurrent.value, desired);
    }

    return false;
  }

  // ─────────────────────────────────────────────────
  //  PHASE 2: EXECUTE MERGED PLAN
  // ─────────────────────────────────────────────────

  async executeMergedPlan() {
    if (!this.planManager.plan || !this.planManager.plan.issues) {
      this.log("  No issues to process in merged plan.");
      return;
    }

    const allIssueKeys = Object.keys(this.planManager.plan.issues);
    const pendingCount = this.planManager.plan.stats.pending || 0;
    const failedCount = this.planManager.plan.stats.failed || 0;
    const total = this.retryFailed ? pendingCount + failedCount : pendingCount;

    if (total === 0) {
      this.log(`  No ${this.retryFailed ? "pending/failed" : "pending"} issues in merged plan.`);
      if (!this.retryFailed && failedCount > 0) {
        this.log(`  (${failedCount} failed issues exist — use --retry-failed to reprocess them)`);
      }
      return;
    }

    this.log(`  Executing merged plan: ${total} issues to update (${allIssueKeys.length} total in plan)...`);
    if (this.retryFailed && failedCount > 0) {
      this.log(`  Including ${failedCount} previously failed issues`);
    }
    this.log(`  Concurrency: ${this.concurrency} parallel requests`);
    if (this.dryRun) {
      this.log("  *** DRY RUN MODE - No changes will be made ***");
    }

    // Collect issues to process
    const pendingIssues = [];
    for (const issueKey of allIssueKeys) {
      const issueData = this.planManager.plan.issues[issueKey];
      if (issueData.status === "pending") {
        pendingIssues.push({ issueKey, issueData });
      } else if (issueData.status === "failed" && this.retryFailed) {
        pendingIssues.push({ issueKey, issueData });
      }
      if (this.limit > 0 && pendingIssues.length >= this.limit) break;
    }

    // Process in batches using concurrent PUTs
    const batchSize = this.concurrency;
    let processed = 0;

    for (let i = 0; i < pendingIssues.length; i += batchSize) {
      const batch = pendingIssues.slice(i, i + batchSize);

      // Build payloads for this batch
      const updates = [];
      for (const { issueKey, issueData } of batch) {
        const payload = this._buildIssuePayload(issueKey, issueData);
        if (payload) {
          updates.push({ issueKey, payload, issueData });
        } else {
          this.stats.issuesSkipped++;
        }
      }

      if (updates.length === 0) continue;

      if (this.dryRun) {
        for (const { issueKey, issueData } of updates) {
          const fieldCount = Object.keys(issueData.fields).length;
          this.log(`    [DRY RUN] ${issueKey}: Would update ${fieldCount} field(s)`);
          this.stats.issuesUpdated++;
          this.stats.issuesProcessed++;
          for (const fieldId of Object.keys(issueData.fields)) {
            this.planManager.updateFieldStatus(issueKey, fieldId, "completed");
          }
        }
        processed += updates.length;
      } else {
        // Fire concurrent PUTs
        const results = await this.cloudJiraClient.updateIssuesBatch(
          updates.map((u) => ({ issueKey: u.issueKey, payload: u.payload })),
          this.concurrency,
        );

        // Process results
        for (const { issueKey, issueData } of updates) {
          this.stats.issuesProcessed++;
          const result = results.get(issueKey);

          if (result && result.success) {
            this.stats.issuesUpdated++;
            for (const fieldId of Object.keys(issueData.fields)) {
              if (issueData.fields[fieldId].status === "pending" || issueData.fields[fieldId].status === "failed") {
                this.planManager.updateFieldStatus(issueKey, fieldId, "completed");
              }
            }
          } else if (result) {
            // Check if it's a screen error — auto-fix and retry the whole PUT first
            const screenFieldId = this.cloudJiraClient.parseScreenError(result.error);
            if (screenFieldId) {
              this.log(`    ${issueKey}: Screen error for ${screenFieldId}, auto-fixing...`);
              const fix = await this.cloudJiraClient.addFieldToScreen(issueKey, screenFieldId);
              if (fix.success) {
                // Also pre-fix all other fields in this issue's payload
                for (const fid of Object.keys(issueData.fields)) {
                  if (fid !== screenFieldId) {
                    await this.cloudJiraClient.addFieldToScreen(issueKey, fid);
                  }
                }
                this.log(`    ${issueKey}: Screen(s) fixed, retrying multi-field PUT...`);
                const retryPayload = this._buildIssuePayload(issueKey, issueData);
                if (retryPayload) {
                  const retryResult = await this.cloudJiraClient.updateIssue(issueKey, retryPayload);
                  if (retryResult.success) {
                    this.stats.issuesUpdated++;
                    for (const fid of Object.keys(issueData.fields)) {
                      if (issueData.fields[fid].status === "pending" || issueData.fields[fid].status === "failed") {
                        this.planManager.updateFieldStatus(issueKey, fid, "completed");
                      }
                    }
                    continue;
                  }
                  this.log(`    ${issueKey}: Multi-field retry still failed, trying per-field...`);
                }
              }
            } else {
              this.log(`    ${issueKey}: Multi-field PUT failed (${result.error}), trying per-field...`);
            }
            await this._executeIssuePerField(issueKey, issueData);
          }
        }
        processed += updates.length;
      }

      // Progress logging
      if (processed % 25 === 0 || processed === updates.length) {
        this.log(`  Progress: ${processed}/${pendingIssues.length} issues processed`);
      }

      // Periodic save
      if (processed % 500 === 0) {
        this.planManager.savePlan();
      }
      if (processed % 100 === 0) {
        this.logRunningStats();
      }
    }

    // Final save
    this.planManager.savePlan();
  }

  /**
   * Build a single PUT payload for an issue with all its pending fields.
   * Uses { fields: { fieldId: {shape, label} } } format.
   */
  _buildIssuePayload(issueKey, issueData) {
    const fields = {};
    let fieldCount = 0;

    for (const [fieldId, fieldData] of Object.entries(issueData.fields)) {
      if (fieldData.status !== "pending" && fieldData.status !== "failed") continue;
      if (!fieldData.cloudValue) {
        this.planManager.updateFieldStatus(issueKey, fieldId, "skipped", "No cloud value");
        continue;
      }

      fields[fieldId] = fieldData.cloudValue;
      fieldCount++;
    }

    if (fieldCount === 0) return null;

    return { fields };
  }

  /**
   * Fallback: try each field individually when multi-field PUT fails.
   * If a field fails with "not on the appropriate screen", auto-adds it and retries.
   * Loops up to maxScreenRetries times in case different fields trigger screen errors.
   */
  async _executeIssuePerField(issueKey, issueData) {
    let anySuccess = false;
    let anyFailed = false;
    const maxScreenRetries = 5;

    for (const [fieldId, fieldData] of Object.entries(issueData.fields)) {
      if (fieldData.status !== "pending" && fieldData.status !== "failed") continue;
      if (!fieldData.cloudValue) continue;

      const payload = { fields: { [fieldId]: fieldData.cloudValue } };
      let result = await this.cloudJiraClient.updateIssue(issueKey, payload);

      // Screen auto-fix loop: keep fixing screens until it works or we exhaust retries
      let screenAttempts = 0;
      while (!result.success && screenAttempts < maxScreenRetries) {
        const screenFieldId = this.cloudJiraClient.parseScreenError(result.error);
        if (!screenFieldId) break; // not a screen error, stop trying

        screenAttempts++;
        this.log(`    ${issueKey}/${fieldData.fieldName}: Screen error for ${screenFieldId} (attempt ${screenAttempts}/${maxScreenRetries}), auto-fixing...`);
        const fix = await this.cloudJiraClient.addFieldToScreen(issueKey, screenFieldId);
        if (fix.success) {
          this.log(`    ${issueKey}/${fieldData.fieldName}: Added ${screenFieldId} to screen, retrying PUT...`);
          result = await this.cloudJiraClient.updateIssue(issueKey, payload);
        } else {
          this.log(`    ${issueKey}/${fieldData.fieldName}: Screen fix failed for ${screenFieldId} - ${fix.error}`);
          break;
        }
      }

      if (result.success) {
        this.log(`    ${issueKey}/${fieldData.fieldName}: OK${screenAttempts > 0 ? ` (after ${screenAttempts} screen fix(es))` : ""}`);
        this.planManager.updateFieldStatus(issueKey, fieldId, "completed");
        anySuccess = true;
      } else {
        this.log(`    ${issueKey}/${fieldData.fieldName}: FAILED - ${result.error}`);
        this.planManager.updateFieldStatus(issueKey, fieldId, "failed", result.error);
        anyFailed = true;
      }
    }

    if (anySuccess) this.stats.issuesUpdated++;
    if (anyFailed) this.stats.issuesFailed++;
  }

  logRunningStats() {
    this.log(`\n  --- Running Stats ---`);
    this.log(`  Fields: ${this.stats.fieldsChecked} checked, ${this.stats.fieldsMatched} matched, ${this.stats.fieldsSkipped} skipped`);
    this.log(`  Issues: ${this.stats.issuesProcessed} processed, ${this.stats.issuesUpdated} updated, ${this.stats.issuesAlreadyInSync} in sync, ${this.stats.issuesFailed} failed, ${this.stats.issuesSkipped} skipped`);
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = TrafficLightProcessor;
