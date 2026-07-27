/**
 * Ember prompt wrapper — the ONE place @inquirer/prompts is imported.
 *
 * Every command file should import from here, not from `@inquirer/prompts`
 * directly. That gives us:
 *
 *  - one place to apply the Ember theme (colors, glyphs, error state)
 *  - one place to enforce the `--yes` / SYNAPSE_NON_INTERACTIVE shortcut
 *  - correct placeholder vs default semantics (default: prompt.default,
 *    placeholder: theme.style.defaultAnswer — press Enter with the buffer
 *    empty ≠ submit the placeholder)
 *  - one seam to swap the prompt library later without touching call sites
 *
 * Exports:
 *   askText     — free-text input with optional placeholder
 *   askSecret   — masked input (no placeholder)
 *   askConfirm  — yes/no
 *   askSelect   — one-of-N single choice
 *   askCheckbox — many-of-N multi-choice
 */

import { input, password, confirm, select, checkbox } from "@inquirer/prompts";
import { t } from "./theme.js";
import { ARROW } from "./icons.js";

// ---------------------------------------------------------------------------
// Non-interactive shortcut — set by `synapse --yes ...` or by any non-TTY run.
// Every ask* helper honors it by returning the caller-provided fallback so
// automation / CI / --yes runs never block on stdin.
// ---------------------------------------------------------------------------

function nonInteractive(): boolean {
  return process.env.SYNAPSE_NON_INTERACTIVE === "1";
}

// ---------------------------------------------------------------------------
// Ember prompt theme
//
// @inquirer/prompts v9+ accepts a `theme` object on every prompt. The
// canonical Ember look:
//   ? (info blue)  Bold primary question text
//   › (brand)      buffer│
//     italic-subtle help text
// Errors flip the marker to ✗ (err) and preserve the buffer.
// ---------------------------------------------------------------------------

const EMBER_THEME = {
  prefix: `${t.info("?")} `,
  spinner: {
    interval: 80,
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as string[],
  },
  style: {
    answer: t.brand,
    message: (m: string) => t.bold(t.primary(m)),
    error: (m: string) => `  ${t.err("✗")} ${t.err(m)}`,
    defaultAnswer: (m: string) => t.subtle(`(${m})`),
    help: (m: string) => t.italic(t.subtle(m)),
    highlight: t.brandBold,
    key: (m: string) => t.warm(`<${m}>`),
    disabled: t.faint,
    description: t.italic,
  },
};

// ---------------------------------------------------------------------------
// askText — free-text input
//
// `placeholder` is rendered as a dim hint AFTER the prompt buffer, and does
// NOT submit if the user hits Enter with the buffer empty (in that case the
// `defaultValue` submits — or "" if no default).
// ---------------------------------------------------------------------------

export interface AskTextOpts {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  help?: string;
  validate?: (v: string) => true | string;
}

export async function askText(opts: AskTextOpts): Promise<string> {
  if (nonInteractive()) return opts.defaultValue ?? "";
  const themed: any = {
    message: opts.message,
    theme: EMBER_THEME,
  };
  if (opts.defaultValue !== undefined) themed.default = opts.defaultValue;
  if (opts.placeholder) themed.placeholder = opts.placeholder;
  if (opts.validate) themed.validate = opts.validate;
  const raw = await input(themed);
  return String(raw ?? "");
}

// ---------------------------------------------------------------------------
// askSecret — masked input (no placeholder — masked prompts don't support it)
// ---------------------------------------------------------------------------

export interface AskSecretOpts {
  message: string;
  validate?: (v: string) => true | string;
}

export async function askSecret(opts: AskSecretOpts): Promise<string> {
  if (nonInteractive()) return "";
  return await password({
    message: opts.message,
    theme: EMBER_THEME,
    ...(opts.validate ? { validate: opts.validate } : {}),
  } as Parameters<typeof password>[0]);
}

// ---------------------------------------------------------------------------
// askConfirm — yes/no
// ---------------------------------------------------------------------------

export interface AskConfirmOpts {
  message: string;
  defaultValue?: boolean;
}

export async function askConfirm(opts: AskConfirmOpts): Promise<boolean> {
  const def = opts.defaultValue ?? false;
  if (nonInteractive()) return def;
  return await confirm({
    message: opts.message,
    default: def,
    theme: EMBER_THEME,
  } as Parameters<typeof confirm>[0]);
}

// ---------------------------------------------------------------------------
// askSelect — single choice
// ---------------------------------------------------------------------------

export interface SelectChoice<T> {
  name: string;
  value: T;
  description?: string;
  disabled?: boolean | string;
}

export interface AskSelectOpts<T> {
  message: string;
  choices: SelectChoice<T>[];
  defaultValue?: T;
  pageSize?: number;
}

export async function askSelect<T>(opts: AskSelectOpts<T>): Promise<T> {
  if (nonInteractive()) {
    return opts.defaultValue !== undefined ? opts.defaultValue : opts.choices[0].value;
  }
  return await select<T>({
    message: opts.message,
    choices: opts.choices,
    theme: EMBER_THEME,
    ...(opts.defaultValue !== undefined ? { default: opts.defaultValue } : {}),
    ...(opts.pageSize ? { pageSize: opts.pageSize } : {}),
  } as Parameters<typeof select<T>>[0]);
}

// ---------------------------------------------------------------------------
// askCheckbox — multi-choice
//
// Ember default: NOTHING pre-checked. Users opt in per row; `a` toggles all.
// Old flows relied on all-pre-checked (dangerous — Enter selects everything),
// so callers migrating should pass `checked: true` per choice if they want
// the old behavior.
// ---------------------------------------------------------------------------

export interface CheckboxChoice<T> {
  name: string;
  value: T;
  description?: string;
  checked?: boolean;
  disabled?: boolean | string;
}

export interface AskCheckboxOpts<T> {
  message: string;
  choices: CheckboxChoice<T>[];
  pageSize?: number;
  /** True by default; ensures at least one item is selected before submit. */
  required?: boolean;
}

export async function askCheckbox<T>(opts: AskCheckboxOpts<T>): Promise<T[]> {
  if (nonInteractive()) {
    return opts.choices.filter((c) => c.checked).map((c) => c.value);
  }
  return await checkbox<T>({
    message: opts.message,
    choices: opts.choices,
    theme: EMBER_THEME,
    required: opts.required ?? true,
    ...(opts.pageSize ? { pageSize: opts.pageSize } : {}),
  } as Parameters<typeof checkbox<T>>[0]);
}

// ---------------------------------------------------------------------------
// Back-compat: existing call sites use `styledInput` and `styledConfirm`.
// Alias them so we don't have to touch every caller in one PR.
// ---------------------------------------------------------------------------

/** @deprecated Use `askText`. */
export async function styledInput(opts: {
  message: string;
  placeholder?: string;
  mask?: boolean;
  validate?: (v: string) => true | string;
}): Promise<string> {
  if (opts.mask) return await askSecret({ message: opts.message, validate: opts.validate });
  return await askText({
    message: opts.message,
    placeholder: opts.placeholder,
    validate: opts.validate,
  });
}

/** @deprecated Use `askConfirm`. */
export async function styledConfirm(message: string, defaultValue = false): Promise<boolean> {
  return await askConfirm({ message, defaultValue });
}

// Re-export the arrow so old callers importing it from styled-input keep working.
export { ARROW };
