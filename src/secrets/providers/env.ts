import { envOf, secretError, type SecretContext } from './shared.js';

export function resolveEnvSecret(ref: { name: string }, ctx: SecretContext): Promise<string> {
  const value = envOf(ctx)[ref.name]?.trim();
  if (!value) {
    return Promise.reject(
      secretError(ctx, 'env', `environment variable ${ref.name} is not set or empty`),
    );
  }
  return Promise.resolve(value);
}
