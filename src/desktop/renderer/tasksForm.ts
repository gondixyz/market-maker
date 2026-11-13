/**
 * The tasks file as the window's form edits it: every field a string, as typed, so a half-written
 * amount is kept rather than rejected on each keystroke. `formOf` reads a saved file into it and
 * `fileOf` writes it back as the JSON main validates; main's schema stays the only validation.
 */

import { parseEther } from 'viem';

import { type Venue, VENUES } from '../../engine/market';
import { BID_EXPIRATION_MINUTES, LISTING_EXPIRATION_MINUTES } from '../../engine/task';
import type { CollectionPricing } from '../api';

export type BidPricingMode =
  | 'outbid'
  | 'outbidPercent'
  | 'floor'
  | 'floorSteps'
  | 'fixed'
  | 'level';
export type ListingPricingMode = 'undercut' | 'floor' | 'fixed';

export type TaskForm = {
  id: string;
  kind: 'collectionBid' | 'listing';
  /** A disabled task stays in the file and does not run. */
  enabled: boolean;
  /** Where a bid is posted; a listing has none and leaves it as `gondi`. */
  venue: Venue;
  collection: string;
  pricingMode: BidPricingMode | ListingPricingMode;
  price: string;
  percent: string;
  steps: string;
  level: string;
  /** How far under the cheapest other listing an undercut listing asks, in ETH. */
  amount: string;
  minPrice: string;
  maxPrice: string;
  expirationMinutes: string;
  quantity: string;
  maxItems: string;
  maxHeldValue: string;
  maxFloorPercent: string;
  haltOnFloorMovePercent: string;
  tokenId: string;
};

export type TasksForm = {
  exposureLimit: string;
  pollSeconds: string;
  lossLimitsEnabled: boolean;
  dailyUsd: string;
  weeklyUsd: string;
  /** The UTC day fills start counting from, as `YYYY-MM-DD`. */
  since: string;
  /** The file's `since` as loaded, written back unchanged while `since` still shows its UTC day. */
  sinceSaved: string;
  tasks: TaskForm[];
};

type Json = Record<string, unknown>;

const venueOf = (value: unknown): Venue => VENUES.find((venue) => venue === value) ?? 'gondi';

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const objectOf = (value: unknown): Json => (isObject(value) ? value : {});

const idOf = (kind: TaskForm['kind'], takenIds: string[]) => {
  const prefix = kind === 'listing' ? 'listing' : 'bid';
  let number = 1;
  while (takenIds.includes(`${prefix}-${number}`)) number += 1;
  return `${prefix}-${number}`;
};

/** What `expirationMinutes` of a task of `kind` defaults to, as the tasks file schema has it. */
export const defaultExpirationOf = (kind: TaskForm['kind']) =>
  String(kind === 'listing' ? LISTING_EXPIRATION_MINUTES : BID_EXPIRATION_MINUTES);

/** A new task of `kind`, given the first `bid-<n>` or `listing-<n>` id none of `takenIds` uses. */
export const newTask = (kind: TaskForm['kind'], takenIds: string[]): TaskForm => ({
  id: idOf(kind, takenIds),
  kind,
  enabled: true,
  venue: 'gondi',
  collection: '',
  pricingMode: kind === 'listing' ? 'undercut' : 'outbid',
  price: '',
  percent: '',
  steps: '1',
  level: '5',
  amount: '',
  minPrice: '',
  maxPrice: '',
  expirationMinutes: defaultExpirationOf(kind),
  quantity: '1',
  maxItems: '',
  maxHeldValue: '',
  maxFloorPercent: '',
  haltOnFloorMovePercent: '',
  tokenId: '',
});

const pricingModeOf = (kind: TaskForm['kind'], pricing: Json): TaskForm['pricingMode'] => {
  const mode = textOf(pricing.mode);
  if (kind === 'listing') return mode === 'fixed' || mode === 'floor' ? mode : 'undercut';
  if (mode === 'outbid') return pricing.percent === undefined ? 'outbid' : 'outbidPercent';
  if (mode === 'floor') return pricing.steps === undefined ? 'floor' : 'floorSteps';
  return mode === 'fixed' || mode === 'level' ? mode : 'outbid';
};

const taskFormOf = (raw: unknown): TaskForm => {
  const task = objectOf(raw);
  const kind = task.kind === 'listing' ? 'listing' : 'collectionBid';
  const pricing = objectOf(task.pricing);
  return {
    ...newTask(kind, []),
    id: textOf(task.id),
    enabled: task.enabled !== false,
    venue: venueOf(task.venue),
    collection: textOf(task.collection),
    pricingMode: pricingModeOf(kind, pricing),
    price: textOf(pricing.price),
    percent: textOf(pricing.percent),
    steps: textOf(pricing.steps) || '1',
    level: textOf(pricing.level) || '5',
    amount: textOf(pricing.amount),
    minPrice: textOf(task.minPrice),
    maxPrice: textOf(task.maxPrice),
    expirationMinutes: textOf(task.expirationMinutes) || defaultExpirationOf(kind),
    quantity: textOf(task.quantity) || '1',
    maxItems: textOf(task.maxItems),
    maxHeldValue: textOf(task.maxHeldValue),
    maxFloorPercent: textOf(task.maxFloorPercent),
    haltOnFloorMovePercent: textOf(task.haltOnFloorMovePercent),
    tokenId: textOf(task.tokenId),
  };
};

/** The UTC day of an ISO datetime as `YYYY-MM-DD`, or its first ten characters if it is not one. */
const utcDayOf = (datetime: string) => {
  const time = Date.parse(datetime);
  return Number.isNaN(time) ? datetime.slice(0, 10) : new Date(time).toISOString().slice(0, 10);
};

/**
 * The form for a saved tasks file. Reads leniently: a field the file lacks or holds as the wrong
 * type starts empty, and text that is not JSON at all starts an empty form.
 */
export const formOf = (text: string): TasksForm => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = {};
  }
  const file = objectOf(raw);
  const lossLimits = isObject(file.lossLimits) ? file.lossLimits : undefined;
  const sinceSaved = textOf(lossLimits?.since);
  return {
    exposureLimit: textOf(file.exposureLimit),
    pollSeconds: textOf(file.pollSeconds) || '15',
    lossLimitsEnabled: lossLimits !== undefined,
    dailyUsd: textOf(lossLimits?.dailyUsd),
    weeklyUsd: textOf(lossLimits?.weeklyUsd),
    since: utcDayOf(sinceSaved),
    sinceSaved,
    tasks: (Array.isArray(file.tasks) ? file.tasks : []).map(taskFormOf),
  };
};

/** A number field: a number when it reads as one, else the text, for the schema to reject. */
const numberOf = (text: string) => {
  const trimmed = text.trim();
  return trimmed !== '' && Number.isFinite(Number(trimmed)) ? Number(trimmed) : trimmed;
};

/** Drops the fields left empty, so the schema's defaults and optionals apply. */
const withoutEmpty = (fields: Json) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== ''));

const pricingOf = (task: TaskForm): Json => {
  switch (task.pricingMode) {
    case 'fixed':
      return { mode: 'fixed', price: task.price.trim() };
    case 'floor':
      return { mode: 'floor', percent: numberOf(task.percent) };
    case 'floorSteps':
      return { mode: 'floor', steps: numberOf(task.steps) };
    case 'outbidPercent':
      return { mode: 'outbid', percent: numberOf(task.percent) };
    case 'outbid':
      return { mode: 'outbid', steps: numberOf(task.steps) };
    case 'undercut':
      return withoutEmpty({ mode: 'undercut', amount: task.amount.trim() });
    case 'level':
      return { mode: 'level', level: numberOf(task.level) };
  }
};

const taskFileOf = (task: TaskForm): Json => {
  const shared = {
    id: task.id.trim(),
    kind: task.kind,
    ...(!task.enabled && { enabled: false }),
    collection: task.collection.trim(),
    pricing: pricingOf(task),
    minPrice: task.minPrice.trim(),
    maxPrice: task.maxPrice.trim(),
    expirationMinutes: numberOf(task.expirationMinutes),
  };
  return withoutEmpty(
    task.kind === 'listing'
      ? { ...shared, tokenId: task.tokenId.trim() }
      : {
          ...shared,
          venue: task.venue === 'gondi' ? '' : task.venue,
          quantity: numberOf(task.quantity),
          maxItems: numberOf(task.maxItems),
          maxHeldValue: task.maxHeldValue.trim(),
          maxFloorPercent: numberOf(task.maxFloorPercent),
          haltOnFloorMovePercent: numberOf(task.haltOnFloorMovePercent),
        },
  );
};

/** The `since` to save: the loaded one while the form shows its UTC day, else the day's midnight. */
const sinceOf = ({ since, sinceSaved }: TasksForm) => {
  if (since === '') return '';
  return since === utcDayOf(sinceSaved) ? sinceSaved : `${since}T00:00:00Z`;
};

/** The tasks file the form describes, as the JSON text main saves and validates. */
export const fileOf = (form: TasksForm) =>
  `${JSON.stringify(
    withoutEmpty({
      version: 1,
      exposureLimit: form.exposureLimit.trim(),
      pollSeconds: numberOf(form.pollSeconds),
      ...(form.lossLimitsEnabled && {
        lossLimits: {
          dailyUsd: numberOf(form.dailyUsd),
          weeklyUsd: numberOf(form.weeklyUsd),
          since: sinceOf(form),
        },
      }),
      tasks: form.tasks.map(taskFileOf),
    }),
    null,
    2,
  )}\n`;

const plural = (count: string, word: string) =>
  `${count} ${word}${count.trim() === '1' ? '' : 's'}`;

const pricingSummaryOf = (task: TaskForm, unit: string) => {
  switch (task.pricingMode) {
    case 'fixed':
      return `${task.price || '?'} ${unit}`;
    case 'floor':
      return `${task.percent || '?'}% of the ${task.kind === 'listing' ? 'cheapest listing' : 'floor'}`;
    case 'outbidPercent':
      return `Outbid by ${task.percent || '?'}%`;
    case 'outbid':
      return `Outbid by ${plural(task.steps, 'step')}`;
    case 'undercut':
      return `Undercut by ${task.amount || '?'} ${unit}`;
    case 'level':
      return `Bid level ${task.level || '?'}`;
  }
};

/** A price move above this share of the floor, in percent, makes a rule overshoot the market. */
const FLOOR_SHARE_WARNING_PERCENT = 20n;

/** `amount` as a whole percentage of `floor`, when it is over `FLOOR_SHARE_WARNING_PERCENT`. */
const floorShareOver = (amount: bigint, floor: bigint) =>
  floor > 0n && amount * 100n > floor * FLOOR_SHARE_WARNING_PERCENT
    ? ((amount * 100n) / floor).toLocaleString('en-US')
    : null;

/** An amount the tasks file reads as ETH, such as "0.0001". */
const ETH_AMOUNT = /^\d+(\.\d{1,18})?$/;

/** What a step-priced rule does when one step is a large share of the floor, by pricing mode. */
const STEP_CONSEQUENCES: Partial<Record<TaskForm['pricingMode'], (steps: string) => string>> = {
  outbid: (steps) => `Outbidding by ${steps} can bid far above the best bid, up to your max price.`,
  outbidPercent: () =>
    'Outbidding by a percentage still raises the best bid by at least one step, up to your max price.',
  floorSteps: (steps) =>
    `Bidding ${steps} under the floor can bid far below it, or your min price when it lands under that.`,
};

/**
 * The warning the editor shows when bid `task` prices in steps and one step of its collection is
 * more than `FLOOR_SHARE_WARNING_PERCENT` of the floor; `null` otherwise, and without a floor.
 */
export const stepWarningOf = (task: TaskForm, { priceStep, floor }: CollectionPricing) => {
  const consequence = STEP_CONSEQUENCES[task.pricingMode];
  if (!consequence || floor === null) return null;
  const percent = floorShareOver(parseEther(priceStep), parseEther(floor));
  if (percent === null) return null;
  return (
    `One price step (${priceStep} WETH) is ${percent}% of the floor (${floor} ETH). ` +
    consequence(plural(task.steps, 'step'))
  );
};

/**
 * The warning the editor shows when undercut listing `task` asks more than
 * `FLOOR_SHARE_WARNING_PERCENT` of the floor under the cheapest listing; `null` otherwise, without
 * a floor, or while the amount is not one yet.
 */
export const undercutWarningOf = (task: TaskForm, { floor }: CollectionPricing) => {
  const amount = task.amount.trim();
  if (task.pricingMode !== 'undercut' || floor === null || !ETH_AMOUNT.test(amount)) return null;
  const percent = floorShareOver(parseEther(amount), parseEther(floor));
  if (percent === null) return null;
  return (
    `Your undercut (${amount} ETH) is ${percent}% of the floor (${floor} ETH). ` +
    'It can ask far under the floor, or your min price when it lands under that.'
  );
};

/** One line saying how a collapsed task prices: its rule, then its price limits. */
export const summaryOf = (task: TaskForm) => {
  const unit = task.kind === 'listing' ? 'ETH' : 'WETH';
  const limits =
    task.minPrice || task.maxPrice
      ? ` · ${task.minPrice || '0'}–${task.maxPrice || '?'} ${unit}`
      : '';
  return `${pricingSummaryOf(task, unit)}${limits}`;
};

/**
 * One strategy as the window holds it: `task` as edited, `saved` as the file last saved it (`null`
 * for one never saved), under a `key` that stays put while others are added or removed.
 */
export type StrategyEntry = {
  key: number;
  task: TaskForm;
  saved: TaskForm | null;
  editing: boolean;
};

/**
 * What one save writes: the settings of `settings` and every saved strategy as saved, except the
 * one `change` names, written as its new `task` (appended when it was never saved) or left out
 * when `task` is `null`. Each strategy saves on its own, so an edit still open elsewhere is not
 * written with it. `keys` gives the strategy key of each written task, in file order.
 */
export const savedFormWith = (
  settings: TasksForm,
  entries: StrategyEntry[],
  change?: { key: number; task: TaskForm | null },
) => {
  const written = entries.flatMap((entry) => {
    const task = entry.key === change?.key ? change.task : entry.saved;
    return task ? [{ key: entry.key, task }] : [];
  });
  return {
    form: { ...settings, tasks: written.map((each) => each.task) },
    keys: written.map((each) => each.key),
  };
};

/** `fieldErrors` keyed by strategy key instead of file position: `tasks.<key>.<field>`. */
export const errorsByKey = (errors: Map<string, string>, keys: number[]) =>
  new Map(
    [...errors].map(([field, message]) => [
      field.replace(/^tasks\.(\d+)/, (_match, position) => `tasks.${keys[Number(position)]}`),
      message,
    ]),
  );

/** The positions of the tasks `fieldErrors` holds an error for, so the window opens them. */
export const positionsWithErrors = (errors: Map<string, string>) =>
  new Set(
    [...errors.keys()].flatMap((key) => {
      const [, position] = /^tasks\.(\d+)/.exec(key) ?? [];
      return position === undefined ? [] : [Number(position)];
    }),
  );

const PRICING_FIELDS = new Set(['price', 'percent', 'steps', 'level', 'amount']);

/**
 * Main's errors (`<path>: <message>`, the path dotted as zod reports it) keyed by the form field
 * they belong to: `tasks.<n>.<field>` for a task's field, the settings field's name otherwise. A
 * pricing error is keyed by its field (`tasks.0.price`) for a listing, and for a bid when zod can
 * tell which pricing shape was meant; otherwise a bid gets one `tasks.<n>.pricing` issue from its
 * plain union, keyed by `tasks.<n>.pricingMode`. An
 * error with no field of its own stays under its path (`tasks.0`, `file`), for the window to show
 * beside the task or the form.
 */
export const fieldErrors = (errors: string[]) => {
  const byField = new Map<string, string>();
  for (const error of errors) {
    const separator = error.indexOf(': ');
    const path = separator === -1 ? 'file' : error.slice(0, separator);
    const message = separator === -1 ? error : error.slice(separator + 2);
    const segments = path.split('.');
    const field =
      segments[0] === 'tasks' && segments[2] === 'pricing'
        ? [segments[0], segments[1], PRICING_FIELDS.has(segments[3]) ? segments[3] : 'pricingMode']
        : segments[0] === 'lossLimits'
          ? segments.slice(1)
          : segments;
    const key = field.join('.') || 'file';
    if (!byField.has(key)) byField.set(key, message);
  }
  return byField;
};
