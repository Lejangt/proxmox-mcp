import * as clack from '@clack/prompts';
import { CancelledError } from './errors.js';

/*
 * Thin wrapper around @clack/prompts. Commands only talk to this interface,
 * so their logic runs in tests with a scripted prompter and without a TTY.
 * A cancelled prompt (Ctrl+C or Escape) throws CancelledError.
 */

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

export type Validator = (value: string) => string | undefined;

export interface Spinner {
  start(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export interface Prompter {
  intro(title: string): void;
  outro(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  step(message: string): void;
  text(opts: {
    message: string;
    placeholder?: string;
    initialValue?: string;
    defaultValue?: string;
    validate?: Validator;
  }): Promise<string>;
  /** Masked input. The value is never echoed. */
  password(opts: { message: string; validate?: Validator }): Promise<string>;
  select<T>(opts: { message: string; options: SelectOption<T>[]; initialValue?: T }): Promise<T>;
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
  spinner(): Spinner;
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new CancelledError();
  return value as Exclude<T, symbol>;
}

function wrapValidator(validate: Validator | undefined) {
  if (!validate) return undefined;
  return (value: string | undefined) => validate(value ?? '');
}

export function createClackPrompter(): Prompter {
  return {
    intro: (title) => clack.intro(title),
    outro: (message) => clack.outro(message),
    note: (message, title) => clack.note(message, title),
    info: (message) => clack.log.info(message),
    success: (message) => clack.log.success(message),
    warn: (message) => clack.log.warn(message),
    error: (message) => clack.log.error(message),
    step: (message) => clack.log.step(message),
    async text(opts) {
      const validate = wrapValidator(opts.validate);
      return unwrap(
        await clack.text({
          message: opts.message,
          ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
          ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
          ...(opts.defaultValue !== undefined ? { defaultValue: opts.defaultValue } : {}),
          ...(validate ? { validate } : {}),
        }),
      ).trim();
    },
    async password(opts) {
      const validate = wrapValidator(opts.validate);
      return unwrap(
        await clack.password({
          message: opts.message,
          ...(validate ? { validate } : {}),
          clearOnError: true,
        }),
      );
    },
    async select<T>(opts: { message: string; options: SelectOption<T>[]; initialValue?: T }) {
      const options = opts.options.map((o) => ({
        value: o.value,
        label: o.label,
        ...(o.hint !== undefined ? { hint: o.hint } : {}),
      })) as clack.Option<T>[];
      return unwrap<T | symbol>(
        await clack.select<T>({
          message: opts.message,
          options,
          ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
        }),
      ) as T;
    },
    async confirm(opts) {
      return unwrap(
        await clack.confirm({
          message: opts.message,
          ...(opts.initialValue !== undefined ? { initialValue: opts.initialValue } : {}),
        }),
      );
    },
    spinner() {
      const s = clack.spinner();
      return {
        start: (m) => s.start(m),
        stop: (m) => s.stop(m),
        error: (m) => s.error(m),
      };
    },
  };
}
