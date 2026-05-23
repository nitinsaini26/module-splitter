/**
 * ASTra v3 — Co-Change Detector
 *
 * Computes co-change coupling between regions using git history.
 * Designed to be optional: callers can pass precomputed histories
 * to avoid invoking git in tests or restricted environments.
 */

import { execSync } from "child_process";
import * as path from "path";
import type { ASTRegion, CoChangeRecord } from "../types";

export interface CoChangeOptions {
  minCoupling?: number;
  maxRegions?: number;
  maxCommits?: number;
  repoRoot?: string;
}

export type RegionHistoryMap = Map<string, string[]>; // regionId -> commit hashes

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseCommitLines(output: string, maxCommits?: number): string[] {
  const commits = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (maxCommits && commits.length > maxCommits) {
    return commits.slice(0, maxCommits);
  }
  return commits;
}

export function buildCoChangeRecordsFromHistories(
  histories: RegionHistoryMap,
  minCoupling: number = 0.6,
): CoChangeRecord[] {
  const records: CoChangeRecord[] = [];
  const regionIds = [...histories.keys()];

  for (let i = 0; i < regionIds.length; i++) {
    for (let j = i + 1; j < regionIds.length; j++) {
      const a = regionIds[i];
      const b = regionIds[j];
      const commitsA = new Set(histories.get(a) ?? []);
      const commitsB = new Set(histories.get(b) ?? []);
      if (commitsA.size === 0 || commitsB.size === 0) continue;

      let intersection = 0;
      for (const c of commitsA) {
        if (commitsB.has(c)) intersection++;
      }
      const union = commitsA.size + commitsB.size - intersection;
      if (union === 0) continue;

      const coupling = clamp01(intersection / union);
      if (coupling < minCoupling) continue;

      records.push({
        regionA: a,
        regionB: b,
        coChangeCount: intersection,
        totalChanges: union,
        coupling,
      });
    }
  }

  return records;
}

export function collectRegionHistoriesFromGit(
  regions: ASTRegion[],
  filePath: string,
  options: CoChangeOptions = {},
): RegionHistoryMap {
  const histories: RegionHistoryMap = new Map();
  const repoRoot = options.repoRoot ?? path.dirname(filePath);
  const maxRegions = options.maxRegions ?? 30;

  const targetRegions = regions.slice(0, maxRegions);
  for (const region of targetRegions) {
    const range = `${region.startLine},${region.endLine}:${filePath}`;
    const cmd = `git -C "${repoRoot}" log --format=%H -L ${range}`;
    try {
      const output = execSync(cmd, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const commits = parseCommitLines(output, options.maxCommits);
      histories.set(region.id, commits);
    } catch {
      histories.set(region.id, []);
    }
  }

  return histories;
}

export function buildCoChangeRecordsFromGit(
  regions: ASTRegion[],
  filePath: string,
  options: CoChangeOptions = {},
): CoChangeRecord[] {
  const histories = collectRegionHistoriesFromGit(regions, filePath, options);
  return buildCoChangeRecordsFromHistories(
    histories,
    options.minCoupling ?? 0.6,
  );
}
