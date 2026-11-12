import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { version } from '../../../package.json';
import { type Venue, VENUES } from '../../engine/market';
import type {
  CancelListingsResult,
  CollectionOption,
  DesktopStatus,
  TaskStateView,
  WalletBalances,
  WalletProfile,
} from '../api';
import { CollectionPicker, Thumbnail } from './CollectionPicker';
import { EthIcon, WethIcon } from './CurrencyIcons';
import { GondiLogo } from './GondiLogo';
import {
  type BidPricingMode,
  errorsByKey,
  fieldErrors,
  fileOf,
  formOf,
  type ListingPricingMode,
  newTask,
  positionsWithErrors,
  savedFormWith,
  type StrategyEntry,
  summaryOf,
  type TaskForm,
  type TasksForm,
} from './tasksForm';
import { type Theme, useTheme } from './theme';
import { VENUE_NAMES, VenueLabel, VenueSelect } from './VenueSelect';

const api = window.marketMaker;

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );

/**
 * Runs a call into main and keeps its error, if any, for display; the status it resolves with
 * replaces the shown one.
 */
const useAction = (setStatus: (status: DesktopStatus) => void) => {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<DesktopStatus | void>) => {
    setBusy(true);
    setError(null);
    try {
      const status = await action();
      if (status) setStatus(status);
    } catch (thrown) {
      setError(messageOf(thrown));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
};

const Card = ({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) => (
  <section className="card">
    <header className="cardHeader">
      <h2>{title}</h2>
      {aside}
    </header>
    {children}
  </section>
);

/** A labelled input with its unit and the error main reported for it. */
const Field = ({
  label,
  unit,
  error,
  wide,
  children,
}: {
  label: string;
  unit?: string;
  error?: string;
  wide?: boolean;
  children: ReactNode;
}) => (
  <label className={`field${wide ? ' wide' : ''}${error ? ' invalid' : ''}`}>
    <span className="fieldLabel">{label}</span>
    <span className="control">
      {children}
      {unit && <span className="unit">{unit}</span>}
    </span>
    {error && <span className="fieldError">{error}</span>}
  </label>
);

const LINE_ICONS = {
  pencil: 'M13.5 3.5l3 3L7 16H4v-3zM11.5 5.5l3 3',
  gear: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2l1.2 2.1 2.4-.6.6 2.4L16.3 7l-.9 2.3L17 11l-1.9 1.4.3 2.4-2.4.4-1 2.2-2-1.2-2 1.2-1-2.2-2.4-.4.3-2.4L3 11l1.6-1.7L3.7 7l2.1-1.1.6-2.4 2.4.6z',
  back: 'M12 4l-6 6 6 6',
  save: 'M4 4h9.5L16 6.5V16H4zM7 4v4h6V4M7 16v-5h6v5',
  trash: 'M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10M8.5 9v4.5M11.5 9v4.5',
};

/** A 20-unit line icon, drawn in the text colour; decorative, so its button carries the label. */
const LineIcon = ({ name, size = 16 }: { name: keyof typeof LINE_ICONS; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={LINE_ICONS[name]} />
  </svg>
);

const PILL_OF_STATUS: Record<TaskStateView['status'], { label: string; tone: string }> = {
  starting: { label: 'Starting', tone: 'neutral' },
  bidding: { label: 'Bidding', tone: 'positive' },
  listing: { label: 'Listed', tone: 'positive' },
  listingInventory: { label: 'Listing', tone: 'positive' },
  waiting: { label: 'Waiting', tone: 'attention' },
  halted: { label: 'Halted', tone: 'negative' },
  failing: { label: 'Failing', tone: 'negative' },
};

const KeyCard = ({
  status,
  setStatus,
}: {
  status: DesktopStatus;
  setStatus: (status: DesktopStatus) => void;
}) => {
  const [privateKey, setPrivateKey] = useState('');
  const { error, busy, run } = useAction(setStatus);
  const importKey = () =>
    run(async () => {
      const next = await api.importKey(privateKey);
      setPrivateKey('');
      return next;
    });
  return (
    <Card title="Bot wallet">
      {!status.encryptionAvailable && (
        <p className="notice negative">
          This system offers no secure storage, so a key cannot be saved.
        </p>
      )}
      <div className="row">
        <span className="control grow">
          <input
            type="password"
            autoComplete="off"
            placeholder="0x… private key of a dedicated wallet"
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
          />
        </span>
        <button
          className="button filled"
          disabled={busy || !privateKey || !status.encryptionAvailable}
          onClick={importKey}
        >
          Import key
        </button>
        {status.keyError && (
          <button
            className="button outlined danger"
            disabled={busy}
            onClick={() => run(api.removeKey)}
          >
            Remove key
          </button>
        )}
      </div>
      {status.keyError && <p className="notice negative">{status.keyError}</p>}
      <p className="muted">
        The key is encrypted by your operating system and never leaves this computer.
      </p>
      {error && <p className="notice negative">{error}</p>}
    </Card>
  );
};

const BALANCE_REFRESH_MS = 30_000;

/** `0x3c5F…a1C` style: the address's first three and last three characters. */
const shortAddress = (address: string) => `${address.slice(0, 5)}…${address.slice(-3)}`;

const formatBalance = (amount: string | undefined) =>
  amount === undefined
    ? '–'
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(Number(amount));

/** The wallet's balances, re-read every `BALANCE_REFRESH_MS`; `null` until read, or after a failed read. */
const useBalances = (address: string | null) => {
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  useEffect(() => {
    setBalances(null);
    if (!address) return;
    const read = () => api.balances().then(setBalances, () => setBalances(null));
    void read();
    const timer = setInterval(read, BALANCE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [address]);
  return balances;
};

/** The wallet's GONDI profile, read once per address; `null` until read, or after a failed read. */
const useProfile = (address: string) => {
  const [profile, setProfile] = useState<WalletProfile | null>(null);
  useEffect(() => {
    setProfile(null);
    let current = true;
    api.profile().then(
      (read) => current && setProfile(read),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [address]);
  return profile;
};

/** Two hues taken from the address, so a wallet without a picture keeps one recognisable colour. */
const placeholderOf = (address: string) => {
  const hue = (start: number) => (parseInt(address.slice(start, start + 6), 16) % 360) + 'deg';
  return `linear-gradient(135deg, hsl(${hue(2)} 55% 55%), hsl(${hue(36)} 55% 40%))`;
};

/** The wallet's GONDI picture, or a gradient drawn from its address when it has none. */
const Avatar = ({
  address,
  picture,
  size,
}: {
  address: string;
  picture?: string | null;
  size: number;
}) =>
  picture ? (
    <img className="avatar" src={picture} alt="" width={size} height={size} />
  ) : (
    <span
      className="avatar"
      style={{ background: placeholderOf(address), width: size, height: size }}
      aria-hidden
    />
  );

/**
 * The header's wallet: its ETH and WETH balances, GONDI picture and name, and short address,
 * opening a menu with the full address and the key's removal.
 */
const WalletMenu = ({
  status,
  setStatus,
}: {
  status: DesktopStatus & { address: string };
  setStatus: (status: DesktopStatus) => void;
}) => {
  const balances = useBalances(status.address);
  const profile = useProfile(status.address);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const { error, busy, run } = useAction(setStatus);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);
  return (
    <div className="wallet" ref={container}>
      <button
        className="walletChip"
        aria-expanded={open}
        aria-label={`Bot wallet ${status.address}`}
        onClick={() => setOpen(!open)}
      >
        <span className="balance">
          <EthIcon />
          {formatBalance(balances?.eth)}
        </span>
        <span className="balance">
          <WethIcon />
          {formatBalance(balances?.weth)}
        </span>
        <span className="walletIdentity">
          <Avatar address={status.address} picture={profile?.picture} size={24} />
          <span className="walletNames">
            {profile?.name && <span className="walletName">{profile.name}</span>}
            <span className="walletAddress">{shortAddress(status.address)}</span>
          </span>
        </span>
      </button>
      {open && (
        <div className="walletMenu">
          <span className="fieldLabel">Bot wallet</span>
          <div className="walletProfile">
            <Avatar address={status.address} picture={profile?.picture} size={40} />
            <span className="walletProfileName">{profile?.name ?? 'No GONDI profile name'}</span>
          </div>
          <code className="address">{status.address}</code>
          <p className="muted">
            The key is encrypted by your operating system and never leaves this computer.
          </p>
          <button
            className="button outlined danger small"
            disabled={busy || status.running}
            onClick={() => run(api.removeKey)}
          >
            Remove key
          </button>
          {status.running && <p className="muted">Stop the bot to remove its key.</p>}
          {error && <p className="notice negative">{error}</p>}
        </div>
      )}
    </div>
  );
};

const listingsMessage = (result: CancelListingsResult) => {
  switch (result.outcome) {
    case 'none':
      return "No active listings on the strategies' collections.";
    case 'declined':
      return 'Listings left as they are.';
    case 'cancelled':
      return `Cancelled ${result.count} listing${result.count === 1 ? '' : 's'} in ${result.transactionHashes.join(', ')}`;
  }
};

const ActivityCard = ({
  status,
  setStatus,
}: {
  status: DesktopStatus;
  setStatus: (status: DesktopStatus) => void;
}) => {
  const { error, busy, run } = useAction(setStatus);
  const [listingsResult, setListingsResult] = useState<string | null>(null);
  const cancelListings = () =>
    run(async () => {
      setListingsResult(listingsMessage(await api.cancelAllListings()));
      return api.status();
    });
  return (
    <Card
      title="Activity"
      aside={
        <span className={`pill ${status.running ? 'positive' : 'neutral'}`}>
          {status.running ? 'Running' : 'Stopped'}
        </span>
      }
    >
      <div className="row">
        <button
          className="button brand"
          disabled={busy || status.running || !status.address}
          onClick={() => run(api.start)}
        >
          Start
        </button>
        <button
          className="button outlined"
          disabled={busy || !status.running}
          onClick={() => run(api.stop)}
        >
          Stop
        </button>
        <button
          className="button outlined danger"
          disabled={busy || !status.address}
          onClick={() => run(api.cancelAll)}
        >
          Cancel all bids
        </button>
        <button
          className="button outlined danger"
          disabled={busy || !status.address}
          onClick={cancelListings}
        >
          Cancel all listings…
        </button>
      </div>
      <p className="muted">
        Stop leaves live bids up until they expire; the next start adopts them. Quitting while
        running cancels every bid first.
      </p>
      {listingsResult && <p className="muted">{listingsResult}</p>}
      {status.loss && <p className="notice">{status.loss}</p>}
      {error && <p className="notice negative">{error}</p>}
      {status.tasks.length > 0 && (
        <ul className="states">
          {status.tasks.map((task) => (
            <li key={task.taskId}>
              <span className="taskName">{task.taskId}</span>
              <span className={`pill ${PILL_OF_STATUS[task.status].tone}`}>
                {PILL_OF_STATUS[task.status].label}
              </span>
              <span className="detail">{task.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

const BID_PRICING: Record<BidPricingMode, string> = {
  outbid: 'Outbid by price steps',
  outbidPercent: 'Outbid by a percentage',
  floor: 'Percentage of the floor',
  floorSteps: 'Price steps under the floor',
  fixed: 'Fixed price',
  level: 'Join a competing bid level',
};

const STEP_PRICING = new Set<TaskForm['pricingMode']>(['outbid', 'floorSteps', 'undercut']);

const LISTING_PRICING: Record<ListingPricingMode, string> = {
  undercut: 'Undercut by price steps',
  floor: 'Percentage of the cheapest listing',
  fixed: 'Fixed price',
};

const TaskEditor = ({
  task,
  collections,
  onPickCollection,
  errorOf,
  disabled,
  onChange,
  onRemove,
  onCollapse,
  onSave,
}: {
  task: TaskForm;
  collections: CollectionOption[] | null | undefined;
  onPickCollection: (option: CollectionOption) => void;
  errorOf: (field: string) => string | undefined;
  disabled: boolean;
  onChange: (task: TaskForm) => void;
  onRemove: () => void;
  onCollapse: () => void;
  onSave: () => void;
}) => {
  const text = (field: Exclude<keyof TaskForm, 'enabled'>) => ({
    value: task[field],
    disabled,
    onChange: (event: { target: { value: string } }) =>
      onChange({ ...task, [field]: event.target.value }),
  });
  const isListing = task.kind === 'listing';
  const pricing = isListing ? LISTING_PRICING : BID_PRICING;
  const changeKind = (kind: TaskForm['kind']) =>
    onChange({ ...task, kind, pricingMode: kind === 'listing' ? 'undercut' : 'outbid' });
  return (
    <div className="task">
      <div className="taskHeader">
        <div className="taskIdentity">
          <Field label="Name" error={errorOf('id')}>
            <input {...text('id')} />
          </Field>
          <div className="segmented" role="group" aria-label="Task kind">
            {(['collectionBid', 'listing'] as const).map((kind) => (
              <button
                key={kind}
                className={task.kind === kind ? 'selected' : ''}
                disabled={disabled}
                onClick={() => changeKind(kind)}
              >
                {kind === 'listing' ? 'Listing' : 'Collection bid'}
              </button>
            ))}
          </div>
        </div>
        <span className="spacer" />
        <button
          className="iconButton danger"
          aria-label={`Delete ${task.id || 'strategy'}`}
          title="Delete"
          disabled={disabled}
          onClick={onRemove}
        >
          <LineIcon name="trash" size={18} />
        </button>
        {disabled ? (
          <button
            className="iconButton"
            aria-expanded
            aria-label={`Close ${task.id || 'strategy'}`}
            title="Close"
            onClick={onCollapse}
          >
            <LineIcon name="pencil" />
          </button>
        ) : (
          <button
            className="iconButton filled"
            aria-label={`Save ${task.id || 'strategy'}`}
            title="Save"
            onClick={onSave}
          >
            <LineIcon name="save" size={18} />
          </button>
        )}
      </div>
      {errorOf('') && <p className="notice negative">{errorOf('')}</p>}
      <div className="grid">
        <Field label="Collection" error={errorOf('collection')}>
          <CollectionPicker
            value={task.collection}
            options={collections}
            disabled={disabled}
            search={api.searchCollections}
            onChange={(collection, option) => {
              if (option) onPickCollection(option);
              onChange({ ...task, collection });
            }}
          />
        </Field>
        {!isListing && (
          <Field label="Marketplace" error={errorOf('venue')}>
            <VenueSelect
              value={task.venue}
              disabled={disabled}
              onChange={(venue) => onChange({ ...task, venue })}
            />
          </Field>
        )}
        <Field label="Pricing" error={errorOf('pricingMode')}>
          <select {...text('pricingMode')}>
            {Object.entries(pricing).map(([mode, label]) => (
              <option key={mode} value={mode}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {task.pricingMode === 'fixed' && (
          <Field label="Price" unit={isListing ? 'ETH' : 'WETH'} error={errorOf('price')}>
            <input inputMode="decimal" {...text('price')} />
          </Field>
        )}
        {(task.pricingMode === 'floor' || task.pricingMode === 'outbidPercent') && (
          <Field label="Percentage" unit="%" error={errorOf('percent')}>
            <input inputMode="decimal" {...text('percent')} />
          </Field>
        )}
        {STEP_PRICING.has(task.pricingMode) && (
          <Field label="Price steps" error={errorOf('steps')}>
            <input inputMode="numeric" {...text('steps')} />
          </Field>
        )}
        {task.pricingMode === 'level' && (
          <Field label="Bid level" error={errorOf('level')}>
            <input inputMode="numeric" {...text('level')} />
          </Field>
        )}
        <Field label="Min price" unit={isListing ? 'ETH' : 'WETH'} error={errorOf('minPrice')}>
          <input inputMode="decimal" {...text('minPrice')} />
        </Field>
        <Field label="Max price" unit={isListing ? 'ETH' : 'WETH'} error={errorOf('maxPrice')}>
          <input inputMode="decimal" {...text('maxPrice')} />
        </Field>
        <Field label="Expires after" unit="min" error={errorOf('expirationMinutes')}>
          <input inputMode="numeric" {...text('expirationMinutes')} />
        </Field>
        {isListing ? (
          <Field label="Token id" error={errorOf('tokenId')}>
            <input placeholder="every item held" inputMode="numeric" {...text('tokenId')} />
          </Field>
        ) : (
          <>
            <Field label="Quantity" error={errorOf('quantity')}>
              <input inputMode="numeric" {...text('quantity')} />
            </Field>
            <Field label="Max items held" error={errorOf('maxItems')}>
              <input placeholder="optional" inputMode="numeric" {...text('maxItems')} />
            </Field>
            <Field label="Max value held" unit="ETH" error={errorOf('maxHeldValue')}>
              <input placeholder="optional" inputMode="decimal" {...text('maxHeldValue')} />
            </Field>
            <Field label="Bid at most, of the floor" unit="%" error={errorOf('maxFloorPercent')}>
              <input placeholder="optional" inputMode="decimal" {...text('maxFloorPercent')} />
            </Field>
            <Field
              label="Halt when the floor moves"
              unit="%"
              error={errorOf('haltOnFloorMovePercent')}
            >
              <input
                placeholder="optional"
                inputMode="decimal"
                {...text('haltOnFloorMovePercent')}
              />
            </Field>
          </>
        )}
      </div>
    </div>
  );
};

/** A saved strategy, collapsed to one row: its switch, what it trades and how it prices. */
const TaskSummary = ({
  task,
  collections,
  disabled,
  onToggle,
  onExpand,
}: {
  task: TaskForm;
  collections: CollectionOption[] | null | undefined;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onExpand: () => void;
}) => {
  const collection = collections?.find((option) => option.slug === task.collection);
  return (
    <div className={`task summary${task.enabled ? '' : ' off'}`}>
      <label className="switch" title={task.enabled ? 'Enabled' : 'Disabled'}>
        <input
          type="checkbox"
          role="switch"
          aria-label={`Enable ${task.id}`}
          checked={task.enabled}
          disabled={disabled}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span aria-hidden />
      </label>
      <Thumbnail option={collection} size={32} />
      <span className="summaryNames">
        <span className="taskName">{task.id}</span>
        <span className="muted summaryLine">
          {task.kind === 'listing' ? 'Listing' : 'Bid'} · {collection?.name ?? task.collection}
        </span>
      </span>
      {task.kind === 'listing' ? <span /> : <VenueLabel venue={task.venue} size={16} />}
      <span className="muted summaryLine grow">{summaryOf(task)}</span>
      <button
        className="iconButton"
        aria-expanded={false}
        aria-label={`Edit ${task.id}`}
        title="Edit"
        onClick={onExpand}
      >
        <LineIcon name="pencil" />
      </button>
    </div>
  );
};

const SETTING_FIELDS = new Set(['exposureLimit', 'pollSeconds', 'dailyUsd', 'weeklyUsd', 'since']);
const TASK_FIELDS = new Set(Object.keys(newTask('collectionBid', [])));

/**
 * The collections the strategies show and the picker lists: the week's top ones, then those picked
 * from a search (`remember`) and those of `slugs` that are not among them, each looked up once, so
 * a collection outside the top ones keeps its name and image. `undefined` while the top ones load;
 * `null` when they could not be read. The lookup is a search by the slug, which matches names and
 * slugs as substrings and answers only the 30 busiest matches, so a short or generic slug (`ape`)
 * can miss and its strategy then shows the bare slug.
 */
const useCollections = (slugs: string[]) => {
  const [top, setTop] = useState<CollectionOption[] | null | undefined>();
  const [others, setOthers] = useState<CollectionOption[]>([]);
  const lookedUp = useRef(new Set<string>());
  useEffect(() => {
    api.collections().then(setTop, () => setTop(null));
  }, []);
  const remember = useCallback(
    (option: CollectionOption) =>
      setOthers((current) =>
        current.some(({ slug }) => slug === option.slug) ? current : [...current, option],
      ),
    [],
  );
  const missing = top
    ? [...new Set(slugs)].filter(
        (slug) =>
          slug && !lookedUp.current.has(slug) && !top.some((option) => option.slug === slug),
      )
    : [];
  useEffect(() => {
    for (const slug of missing) {
      lookedUp.current.add(slug);
      api.searchCollections(slug).then(
        (found) => {
          const match = found.find((option) => option.slug === slug);
          if (match) remember(match);
        },
        () => undefined,
      );
    }
  }, [missing.join('\n'), remember]);
  const collections = top && [
    ...top,
    ...others.filter(({ slug }) => !top.some((option) => option.slug === slug)),
  ];
  return { collections, remember };
};

/**
 * The strategies (the tasks file's tasks) and the settings they share, each saved on its own:
 * "Save configuration" writes the settings beside the strategies as last saved; a strategy's save
 * icon writes that strategy; its switch flips and saves it at once; its trash deletes and saves.
 * An edit still open elsewhere is never written along. A saved strategy shows collapsed, with a
 * pencil that opens it; a new one, and one a save rejects, opens.
 */
const StrategiesCard = ({ running }: { running: boolean }) => {
  const [form, setForm] = useState<TasksForm | null>(null);
  const [savedSettings, setSavedSettings] = useState<TasksForm | null>(null);
  const [entries, setEntries] = useState<StrategyEntry[]>([]);
  const { collections, remember } = useCollections(entries.map(({ task }) => task.collection));
  const [nextKey, setNextKey] = useState(0);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [warnings, setWarnings] = useState<string[]>([]);
  const [settingsSaved, setSettingsSaved] = useState(false);
  useEffect(() => {
    void api.loadTasks().then((text) => {
      const loaded = formOf(text);
      setForm(loaded);
      setSavedSettings(loaded);
      setEntries(loaded.tasks.map((task, key) => ({ key, task, saved: task, editing: false })));
      setNextKey(loaded.tasks.length);
    });
  }, []);
  if (!form || !savedSettings) return null;
  const setting = (
    field: 'exposureLimit' | 'pollSeconds' | 'dailyUsd' | 'weeklyUsd' | 'since',
  ) => ({
    value: form[field],
    disabled: running,
    onChange: (event: { target: { value: string } }) => {
      setForm({ ...form, [field]: event.target.value });
      setSettingsSaved(false);
    },
  });
  const changeEntry = (key: number, change: Partial<StrategyEntry>) =>
    setEntries((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...change } : entry)),
    );
  /** A new strategy opens as a collection bid; its header switches it to a listing. */
  const addTask = () => {
    const task = newTask(
      'collectionBid',
      entries.map((entry) => entry.task.id),
    );
    setEntries([...entries, { key: nextKey, task, saved: null, editing: true }]);
    setNextKey(nextKey + 1);
  };
  /** Saves `settings` and the strategies as saved, with `change` applied; true once written. */
  const save = async (settings: TasksForm, change?: { key: number; task: TaskForm | null }) => {
    const { form: toSave, keys } = savedFormWith(settings, entries, change);
    const result = await api.saveTasks(fileOf(toSave));
    const keyed = result.ok
      ? new Map<string, string>()
      : errorsByKey(fieldErrors(result.errors), keys);
    setErrors(keyed);
    setWarnings(result.ok ? result.warnings : []);
    if (result.ok) {
      setSavedSettings(settings);
    } else {
      const failing = new Set(
        [...positionsWithErrors(fieldErrors(result.errors))].map((position) => keys[position]),
      );
      setEntries((current) =>
        current.map((entry) => (failing.has(entry.key) ? { ...entry, editing: true } : entry)),
      );
    }
    return result.ok;
  };
  const saveSettings = async () => setSettingsSaved(await save(form));
  const saveStrategy = async (entry: StrategyEntry) => {
    if (await save(savedSettings, { key: entry.key, task: entry.task })) {
      changeEntry(entry.key, { saved: entry.task, editing: false });
    }
  };
  const deleteStrategy = async (entry: StrategyEntry) => {
    if (entry.saved === null || (await save(savedSettings, { key: entry.key, task: null }))) {
      setEntries((current) => current.filter((each) => each.key !== entry.key));
    }
  };
  const toggle = async (entry: StrategyEntry, enabled: boolean) => {
    if (!entry.saved) return;
    const task = { ...entry.saved, enabled };
    if (await save(savedSettings, { key: entry.key, task })) {
      changeEntry(entry.key, { saved: task, task: { ...entry.task, enabled } });
    }
  };
  const isShown = (key: string) => {
    if (SETTING_FIELDS.has(key)) return true;
    const [, strategyKey, field] = /^tasks\.(\d+)(?:\.(\w+))?$/.exec(key) ?? [];
    return (
      strategyKey !== undefined &&
      entries.some((entry) => entry.key === Number(strategyKey) && entry.editing) &&
      (field === undefined || TASK_FIELDS.has(field))
    );
  };
  const otherErrors = [...errors].filter(([key]) => !isShown(key));
  return (
    <Card
      title="Strategies"
      aside={running && <span className="muted">Stop the bot to change its strategies.</span>}
    >
      <div className="grid">
        <Field label="Exposure limit" unit="WETH" error={errors.get('exposureLimit')}>
          <input inputMode="decimal" {...setting('exposureLimit')} />
        </Field>
        <Field label="Re-check every" unit="s" error={errors.get('pollSeconds')}>
          <input inputMode="numeric" {...setting('pollSeconds')} />
        </Field>
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          checked={form.lossLimitsEnabled}
          disabled={running}
          onChange={(event) => {
            setForm({ ...form, lossLimitsEnabled: event.target.checked });
            setSettingsSaved(false);
          }}
        />
        Stop bidding at a daily or weekly loss
      </label>
      {form.lossLimitsEnabled && (
        <div className="grid">
          <Field label="Daily loss cap" unit="USD" error={errors.get('dailyUsd')}>
            <input inputMode="decimal" {...setting('dailyUsd')} />
          </Field>
          <Field label="Weekly loss cap" unit="USD" error={errors.get('weeklyUsd')}>
            <input inputMode="decimal" {...setting('weeklyUsd')} />
          </Field>
          <Field label="Count fills from (UTC)" error={errors.get('since')}>
            <input type="date" {...setting('since')} />
          </Field>
        </div>
      )}
      <div className="row">
        <span className="spacer" />
        {settingsSaved && <span className="positiveText">Saved.</span>}
        <button className="button filled" disabled={running} onClick={saveSettings}>
          Save configuration
        </button>
      </div>
      {entries.map((entry) =>
        entry.editing ? (
          <TaskEditor
            key={entry.key}
            task={entry.task}
            collections={collections}
            onPickCollection={remember}
            disabled={running}
            errorOf={(field) => errors.get(`tasks.${entry.key}${field && `.${field}`}`)}
            onChange={(task) => changeEntry(entry.key, { task })}
            onRemove={() => void deleteStrategy(entry)}
            onCollapse={() => changeEntry(entry.key, { editing: false })}
            onSave={() => void saveStrategy(entry)}
          />
        ) : (
          <TaskSummary
            key={entry.key}
            task={entry.task}
            collections={collections}
            disabled={running}
            onToggle={(enabled) => void toggle(entry, enabled)}
            onExpand={() => changeEntry(entry.key, { editing: true })}
          />
        ),
      )}
      {entries.length === 0 && <p className="muted">No strategies yet.</p>}
      <div className="row">
        <button className="button outlined" disabled={running} onClick={addTask}>
          + New strategy
        </button>
      </div>
      {otherErrors.length > 0 && (
        <p className="notice negative">
          {otherErrors.map(([key, message]) => `${key}: ${message}`).join('\n')}
        </p>
      )}
      {warnings.length > 0 && <p className="notice attention">{warnings.join('\n')}</p>}
    </Card>
  );
};

/** The user's OpenSea API key: saved encrypted in main, shown here only as saved or not. */
const OpenSeaKeyCard = ({
  status,
  setStatus,
}: {
  status: DesktopStatus;
  setStatus: (status: DesktopStatus) => void;
}) => {
  const [apiKey, setApiKey] = useState('');
  const { error, busy, run } = useAction(setStatus);
  const save = () =>
    run(async () => {
      const next = await api.importOpenSeaKey(apiKey);
      setApiKey('');
      return next;
    });
  return (
    <Card title="OpenSea API key">
      <p className="muted">
        Bids posted on OpenSea need your own key, from opensea.io/settings/developer. It is
        encrypted like the wallet key and only ever sent to OpenSea.
      </p>
      {status.openSeaKey ? (
        <div className="row">
          <span className="grow">A key is saved.</span>
          <button
            className="button outlined danger"
            disabled={busy || status.running}
            onClick={() => run(api.removeOpenSeaKey)}
          >
            Remove key
          </button>
        </div>
      ) : (
        <div className="row">
          <span className="control grow">
            <input
              type="password"
              autoComplete="off"
              placeholder="OpenSea API key"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </span>
          <button
            className="button filled"
            disabled={busy || !apiKey || status.running || !status.encryptionAvailable}
            onClick={save}
          >
            Save key
          </button>
        </div>
      )}
      {error && <p className="notice negative">{error}</p>}
    </Card>
  );
};

const RpcCard = ({
  status,
  setStatus,
}: {
  status: DesktopStatus;
  setStatus: (status: DesktopStatus) => void;
}) => {
  const [url, setUrl] = useState('');
  const { error, busy, run } = useAction(setStatus);
  const save = () =>
    run(async () => {
      const next = await api.saveRpcUrl(url);
      setUrl('');
      return next;
    });
  return (
    <Card title="Ethereum RPC">
      <p className="muted">
        The bot reads the chain and sends approvals and cancels through this endpoint. Without one
        it uses a public endpoint, which limits how often a bot may ask; a provider such as Alchemy
        or Infura gives you your own for free. Its URL usually holds your provider key, so it is
        encrypted like the wallet key.
      </p>
      {status.rpcUrlFromEnvironment && (
        <p className="notice">
          MARKET_MAKER_RPC_URL is set where the app started, so the bot uses it instead.
        </p>
      )}
      {status.rpcHost ? (
        <div className="row">
          <span className="grow">Using {status.rpcHost}.</span>
          <button
            className="button outlined danger"
            disabled={busy || status.running}
            onClick={() => run(api.removeRpcUrl)}
          >
            Remove URL
          </button>
        </div>
      ) : (
        <div className="row">
          <span className="control grow">
            <input
              type="password"
              autoComplete="off"
              placeholder="https://eth-mainnet.g.alchemy.com/v2/…"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </span>
          <button
            className="button filled"
            disabled={busy || !url || status.running || !status.encryptionAvailable}
            onClick={save}
          >
            {busy ? 'Checking…' : 'Save URL'}
          </button>
        </div>
      )}
      {error && <p className="notice negative">{error}</p>}
    </Card>
  );
};

const SPENDER_NAMES: Record<Venue, string> = { gondi: 'Seaport', opensea: "OpenSea's conduit" };

const AllowanceCard = ({ address }: { address: string | null }) => {
  const [amount, setAmount] = useState('');
  const [venue, setVenue] = useState<Venue>('gondi');
  const [result, setResult] = useState<string | null>(null);
  const { error, busy, run } = useAction(() => undefined);
  const approve = () =>
    run(async () => {
      const outcome = await api.approveWeth(amount, venue);
      setResult(
        outcome.outcome === 'approved' ? `Approved in ${outcome.transactionHash}` : 'Declined.',
      );
    });
  return (
    <Card
      title="WETH allowance"
      aside={
        <div className="segmented" role="group" aria-label="Bids on">
          {VENUES.map((option) => (
            <button
              key={option}
              className={venue === option ? 'selected' : ''}
              onClick={() => setVenue(option)}
            >
              <VenueLabel venue={option} size={16} />
            </button>
          ))}
        </div>
      }
    >
      <p className="muted">
        Bids on {VENUE_NAMES[venue]} need {SPENDER_NAMES[venue]} to be allowed to spend your WETH.
        This is the one action that sends a transaction; you confirm it in a separate dialog.
      </p>
      <div className="row">
        <span className="control grow">
          <input
            inputMode="decimal"
            placeholder="Amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <span className="unit">WETH</span>
        </span>
        <button className="button filled" disabled={busy || !amount || !address} onClick={approve}>
          Approve…
        </button>
      </div>
      {result && <p className="muted">{result}</p>}
      {error && <p className="notice negative">{error}</p>}
    </Card>
  );
};

const ICON_PATHS: Record<Theme, string> = {
  light:
    'M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4',
  dark: 'M16 12.5A6.5 6.5 0 0 1 7.5 4a6.5 6.5 0 1 0 8.5 8.5z',
};

/** The header's theme picker: light or dark. */
const ThemeSelector = () => {
  const [theme, setTheme] = useTheme();
  return (
    <div className="segmented icons" role="radiogroup" aria-label="Theme">
      {(['light', 'dark'] as const).map((option) => (
        <button
          key={option}
          role="radio"
          aria-checked={theme === option}
          aria-label={option === 'light' ? 'Light theme' : 'Dark theme'}
          title={option === 'light' ? 'Light theme' : 'Dark theme'}
          className={theme === option ? 'selected' : ''}
          onClick={() => setTheme(option)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d={ICON_PATHS[option]} />
          </svg>
        </button>
      ))}
    </div>
  );
};

/** The settings the gear opens: the OpenSea API key and the WETH allowances. */
const SettingsView = ({
  status,
  setStatus,
  onClose,
}: {
  status: DesktopStatus;
  setStatus: (status: DesktopStatus) => void;
  onClose: () => void;
}) => (
  <main className="settings">
    <div className="row">
      <button className="button outlined small" onClick={onClose}>
        <LineIcon name="back" size={14} />
        Back
      </button>
      <h2>Settings</h2>
    </div>
    <RpcCard status={status} setStatus={setStatus} />
    <OpenSeaKeyCard status={status} setStatus={setStatus} />
    <AllowanceCard address={status.address} />
  </main>
);

/** A strip under the top bar saying whether the bot runs: green while it does, grey when stopped. */
const StatusBanner = ({ running }: { running: boolean }) => (
  <div className={`statusBanner ${running ? 'running' : 'stopped'}`} role="status">
    <span className="statusDot" aria-hidden />
    {running ? 'Bot running' : 'Bot stopped'}
  </div>
);

/**
 * The desktop window: the wallet and the gear in the header; the bot's controls with each
 * strategy's state beside the strategies, or the settings once the gear opens them.
 */
export const App = () => {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    void api.status().then(setStatus);
    return api.onStatus(setStatus);
  }, []);
  return (
    <>
      <header className="topBar">
        <GondiLogo />
        <span className="product">Market Maker</span>
        <span className="version">v{version}</span>
        <div className="topBarEnd">
          {status?.address && (
            <WalletMenu status={{ ...status, address: status.address }} setStatus={setStatus} />
          )}
          <button
            className={`iconButton${settingsOpen ? ' selected' : ''}`}
            aria-pressed={settingsOpen}
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <LineIcon name="gear" size={18} />
          </button>
          <ThemeSelector />
        </div>
      </header>
      {status && <StatusBanner running={status.running} />}
      {status && settingsOpen ? (
        <SettingsView
          status={status}
          setStatus={setStatus}
          onClose={() => setSettingsOpen(false)}
        />
      ) : status ? (
        <main className="columns">
          <div className="column">
            {!status.address && <KeyCard status={status} setStatus={setStatus} />}
            <ActivityCard status={status} setStatus={setStatus} />
          </div>
          <div className="column">
            <StrategiesCard running={status.running} />
          </div>
        </main>
      ) : (
        <main className="muted">Loading…</main>
      )}
    </>
  );
};
