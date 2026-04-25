"use strict";

const CONVENTIONAL_HEADER_PATTERN =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<description>.+)$/;
const BREAKING_FOOTER_PATTERN = /^BREAKING[ -]CHANGE:/m;

function parseConventionalCommit(message) {
  const trimmed = String(message || "").trim();
  const [header = ""] = trimmed.split(/\r?\n/, 1);
  const match = header.match(CONVENTIONAL_HEADER_PATTERN);

  if (!match) {
    return {
      raw: trimmed,
      header,
      type: null,
      scope: null,
      description: null,
      isConventional: false,
      isBreaking: BREAKING_FOOTER_PATTERN.test(trimmed),
      releaseSignal: null,
    };
  }

  const type = match.groups.type;
  const isBreaking = Boolean(match.groups.breaking) || BREAKING_FOOTER_PATTERN.test(trimmed);

  return {
    raw: trimmed,
    header,
    type,
    scope: match.groups.scope || null,
    description: match.groups.description,
    isConventional: true,
    isBreaking,
    releaseSignal: getReleaseSignal(type, isBreaking),
  };
}

function getReleaseSignal(type, isBreaking) {
  if (isBreaking) {
    return "major";
  }

  if (type === "feat") {
    return "minor";
  }

  if (type === "fix") {
    return "patch";
  }

  return null;
}

function getRecommendedBump(messages) {
  let highestRank = 0;

  for (const message of messages) {
    const commit = typeof message === "string" ? parseConventionalCommit(message) : message;
    const rank = getBumpRank(commit.releaseSignal);

    if (rank > highestRank) {
      highestRank = rank;
    }
  }

  return getBumpName(highestRank);
}

function bumpVersion(version, bump) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);

  if (!match) {
    throw new Error(`Unsupported semver version: ${version}`);
  }

  const parts = match.slice(1).map((value) => Number.parseInt(value, 10));

  if (bump === "major") {
    return `${parts[0] + 1}.0.0`;
  }

  if (bump === "minor") {
    return `${parts[0]}.${parts[1] + 1}.0`;
  }

  if (bump === "patch") {
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }

  if (bump == null) {
    return version;
  }

  throw new Error(`Unsupported bump type: ${bump}`);
}

function getBumpRank(bump) {
  if (bump === "major") {
    return 3;
  }

  if (bump === "minor") {
    return 2;
  }

  if (bump === "patch") {
    return 1;
  }

  return 0;
}

function getBumpName(rank) {
  if (rank === 3) {
    return "major";
  }

  if (rank === 2) {
    return "minor";
  }

  if (rank === 1) {
    return "patch";
  }

  return null;
}

module.exports = {
  bumpVersion,
  getRecommendedBump,
  parseConventionalCommit,
};
