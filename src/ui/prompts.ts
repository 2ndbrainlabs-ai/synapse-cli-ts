import { createInterface } from "node:readline";

export async function promptMaskedInput(prompt: string): Promise<string> {
  // Use @inquirer/prompts if available, otherwise fall back to readline
  try {
    const { password } = await import("@inquirer/prompts");
    return await password({ message: prompt.trim() });
  } catch {
    return new Promise((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      // Basic readline fallback (not masked)
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}

export async function promptInput(prompt: string): Promise<string> {
  try {
    const { input } = await import("@inquirer/prompts");
    return await input({ message: prompt.trim() });
  } catch {
    return new Promise((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }
}

export async function promptConfirm(
  message: string,
  defaultValue = true,
): Promise<boolean> {
  try {
    const { confirm } = await import("@inquirer/prompts");
    return await confirm({ message: message.trim(), default: defaultValue });
  } catch {
    const answer = await promptInput(`${message} [${defaultValue ? "Y/n" : "y/N"}] `);
    if (!answer.trim()) return defaultValue;
    return answer.trim().toLowerCase().startsWith("y");
  }
}
