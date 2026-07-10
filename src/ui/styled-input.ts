/**
 * Styled prompt wrappers — orange `›` marker + placeholder, matching Python's
 * `prompt_styled_input`.
 *
 * Wraps `@inquirer/prompts` with a consistent visual prefix. Falls back to
 * readline if inquirer is unavailable.
 */

import readline from "node:readline";
import { t } from "./theme.js";
import { ARROW } from "./icons.js";

interface StyledInputOpts {
  message: string;
  placeholder?: string;
  mask?: boolean;
  /** Validation function returning true if valid, or an error message. */
  validate?: (input: string) => true | string;
}

/**
 * Prompt for text input with Synapse-styled prefix.
 *
 *   ›  Message here
 *      (placeholder text shown dim)
 */
export async function styledInput(opts: StyledInputOpts): Promise<string> {
  const { message, placeholder, mask, validate } = opts;

  try {
    const inquirer = await import("@inquirer/prompts");
    const prompt = mask ? inquirer.password : inquirer.input;
    const styledMessage = `${t.brand(ARROW)}  ${t.text(message)}`;

    // @inquirer/prompts supports `theme` and `default` — use `default` for placeholder
    const result = await prompt({
      message: styledMessage,
      ...(placeholder && !mask ? { default: placeholder } : {}),
      ...(validate ? { validate } : {}),
    } as Parameters<typeof inquirer.input>[0]);

    return String(result ?? "");
  } catch {
    // Fallback: raw readline
    return readlineFallback(message, mask ?? false);
  }
}

function readlineFallback(message: string, mask: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !mask,
    });
    const prompt = `  ${t.brand(ARROW)}  ${t.text(message)}: `;
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Yes/no confirmation.
 */
export async function styledConfirm(
  message: string,
  defaultValue = false,
): Promise<boolean> {
  try {
    const { confirm } = await import("@inquirer/prompts");
    return await confirm({
      message: `${t.brand(ARROW)}  ${t.text(message)}`,
      default: defaultValue,
    });
  } catch {
    return defaultValue;
  }
}
