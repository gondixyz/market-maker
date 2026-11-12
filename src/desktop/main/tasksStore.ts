import { readFile, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { marginWarnings, parseTasksFile, type TasksFile } from '../../engine/task';
import type { SaveTasksResult } from '../api';

/** What a new install starts from: no tasks, a small exposure limit, the default poll. */
export const EMPTY_TASKS = `{
  "version": 1,
  "exposureLimit": "0.5",
  "pollSeconds": 15,
  "tasks": []
}
`;

/** Main's verdict on a tasks file's text: its margin warnings, or each issue as `<path>: <message>`. */
export const parseTasksText = (text: string): SaveTasksResult => {
  try {
    return { ok: true, warnings: marginWarnings(parseTasksFile(JSON.parse(text))) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        errors: error.issues.map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`),
      };
    }
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
};

/**
 * The tasks file the desktop app runs, kept as the text the user wrote (ETH amounts stay readable)
 * and only saved when it parses whole.
 */
export class TasksStore {
  constructor(private readonly path: string) {}

  async text() {
    return readFile(this.path, 'utf8').catch(() => EMPTY_TASKS);
  }

  async save(text: string): Promise<SaveTasksResult> {
    const result = parseTasksText(text);
    if (result.ok) await writeFile(this.path, text);
    return result;
  }

  async load(): Promise<TasksFile> {
    return parseTasksFile(JSON.parse(await this.text()));
  }
}
