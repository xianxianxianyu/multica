/**
 * Skills Invocation Module
 *
 * Handles user-invocable skill commands (/skill-name)
 */

import type {
  Skill,
  SkillCommandSpec,
  SkillCommandDispatch,
  SkillInvocationPolicy,
  SkillInvocationResult,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Maximum length for command names */
const COMMAND_MAX_LENGTH = 32;

/** Fallback command name if normalization produces empty string */
const COMMAND_FALLBACK = "skill";

// ============================================================================
// Policy Resolution
// ============================================================================

/**
 * Resolve invocation policy from skill frontmatter
 *
 * @param skill - Skill to check
 * @returns Invocation policy with defaults applied
 */
export function resolveInvocationPolicy(skill: Skill): SkillInvocationPolicy {
  return {
    userInvocable: skill.frontmatter.userInvocable ?? true,
    disableModelInvocation: skill.frontmatter.disableModelInvocation ?? false,
  };
}

/**
 * Check if a skill is user-invocable
 */
export function isUserInvocable(skill: Skill): boolean {
  return resolveInvocationPolicy(skill).userInvocable;
}

/**
 * Check if a skill should be included in AI's system prompt
 */
export function isModelInvocable(skill: Skill): boolean {
  return !resolveInvocationPolicy(skill).disableModelInvocation;
}

// ============================================================================
// Command Name Normalization
// ============================================================================

/**
 * Sanitize a skill name into a valid command name
 * - Lowercase
 * - Replace non-alphanumeric chars with underscores
 * - Collapse multiple underscores
 * - Trim leading/trailing underscores
 * - Truncate to max length
 */
export function sanitizeCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const trimmed = normalized.slice(0, COMMAND_MAX_LENGTH);
  return trimmed || COMMAND_FALLBACK;
}

/**
 * Resolve a unique command name, adding suffix if needed
 */
function resolveUniqueCommandName(base: string, used: Set<string>): string {
  const normalizedBase = base.toLowerCase();
  if (!used.has(normalizedBase)) return base;

  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const maxBaseLength = Math.max(1, COMMAND_MAX_LENGTH - suffix.length);
    const candidate = `${base.slice(0, maxBaseLength)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }

  return `${base.slice(0, Math.max(1, COMMAND_MAX_LENGTH - 2))}_x`;
}

// ============================================================================
// Command Building
// ============================================================================

/**
 * Resolve command dispatch from skill frontmatter
 */
function resolveCommandDispatch(skill: Skill): SkillCommandDispatch | undefined {
  const kind = skill.frontmatter.commandDispatch;
  if (kind !== "tool") return undefined;

  const toolName = skill.frontmatter.commandTool;
  if (!toolName) return undefined;

  const argMode = skill.frontmatter.commandArgMode;

  return {
    kind: "tool",
    toolName,
    argMode: argMode === "raw" ? "raw" : undefined,
  };
}

/**
 * Build skill command specifications from eligible skills
 *
 * @param skills - Map of skill ID to Skill
 * @param options - Build options
 * @returns Array of command specifications
 */
export function buildSkillCommands(
  skills: Map<string, Skill>,
  options?: {
    /** Reserved command names to avoid */
    reservedNames?: Set<string>;
    /** Only include skills matching these IDs */
    skillFilter?: string[];
  },
): SkillCommandSpec[] {
  const used = new Set<string>();

  // Add reserved names
  for (const reserved of options?.reservedNames ?? []) {
    used.add(reserved.toLowerCase());
  }

  const specs: SkillCommandSpec[] = [];

  for (const [id, skill] of skills) {
    // Skip if not user-invocable
    if (!isUserInvocable(skill)) continue;

    // Apply skill filter if provided
    if (options?.skillFilter && !options.skillFilter.includes(id)) continue;

    // Sanitize command name
    const base = sanitizeCommandName(skill.frontmatter.name);
    const unique = resolveUniqueCommandName(base, used);
    used.add(unique.toLowerCase());

    // Build description (truncate if too long)
    const rawDescription = skill.frontmatter.description?.trim() || skill.frontmatter.name;
    const description =
      rawDescription.length > 100
        ? rawDescription.slice(0, 99) + "…"
        : rawDescription;

    specs.push({
      name: unique,
      skillId: id,
      description,
      dispatch: resolveCommandDispatch(skill),
    });
  }

  return specs;
}

// ============================================================================
// Command Matching
// ============================================================================

/**
 * Normalize a command lookup string for matching
 */
function normalizeForLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/**
 * Find a skill command by name
 *
 * Matches against:
 * - Exact command name
 * - Original skill ID
 * - Normalized versions of both
 */
export function findSkillCommand(
  commands: SkillCommandSpec[],
  rawName: string,
): SkillCommandSpec | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;

  const lowered = trimmed.toLowerCase();
  const normalized = normalizeForLookup(trimmed);

  return commands.find((cmd) => {
    if (cmd.name.toLowerCase() === lowered) return true;
    if (cmd.skillId.toLowerCase() === lowered) return true;
    return (
      normalizeForLookup(cmd.name) === normalized ||
      normalizeForLookup(cmd.skillId) === normalized
    );
  });
}

/**
 * Parse a user command input and resolve to a skill invocation
 *
 * Supports formats:
 * - /command-name args...
 * - /skill command-name args...
 *
 * @param input - Raw user input
 * @param commands - Available skill commands
 * @param skills - Full skill map (for instructions)
 * @returns Invocation result or null if not a skill command
 */
export function resolveSkillInvocation(
  input: string,
  commands: SkillCommandSpec[],
  skills: Map<string, Skill>,
): SkillInvocationResult | null {
  const trimmed = input.trim();

  // Must start with /
  if (!trimmed.startsWith("/")) return null;

  // Parse command and args
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!match) return null;

  const commandName = match[1]?.trim().toLowerCase();
  if (!commandName) return null;

  let command: SkillCommandSpec | undefined;
  let args: string | undefined;

  // Check for /skill <name> <args> format
  if (commandName === "skill") {
    const remainder = match[2]?.trim();
    if (!remainder) return null;

    const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!skillMatch) return null;

    command = findSkillCommand(commands, skillMatch[1] ?? "");
    args = skillMatch[2]?.trim();
  } else {
    // Direct /command format
    command = commands.find((c) => c.name.toLowerCase() === commandName);
    args = match[2]?.trim();
  }

  if (!command) return null;

  // Get skill instructions
  const skill = skills.get(command.skillId);
  if (!skill) return null;

  return {
    command,
    args: args || undefined,
    instructions: skill.instructions,
  };
}

// ============================================================================
// Completion Support
// ============================================================================

/**
 * Get command completions for a prefix
 *
 * @param prefix - Input prefix (with or without leading /)
 * @param commands - Available skill commands
 * @returns Matching command names with leading /
 */
export function getCommandCompletions(
  prefix: string,
  commands: SkillCommandSpec[],
): string[] {
  // Normalize prefix
  const normalized = prefix.startsWith("/") ? prefix.slice(1) : prefix;
  const lowered = normalized.toLowerCase();

  if (!lowered) {
    // Return all commands if empty prefix
    return commands.map((c) => `/${c.name}`);
  }

  // Find matching commands
  const matches: string[] = [];

  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(lowered)) {
      matches.push(`/${cmd.name}`);
    }
  }

  // Sort by name length (shorter first) then alphabetically
  matches.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });

  return matches;
}
