import { createHmac, randomBytes, randomUUID } from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = (value, key) => createHmac('sha256', key).update(JSON.stringify(canonical(value))).digest('hex');

export function createActionConfirmation({ payload, scope, tab, session, now = Date.now() }) {
  if (typeof scope !== 'string' || !scope || !tab) throw new Error('Missing action confirmation scope');
  const bindingKey = randomBytes(32).toString('hex');
  return {
    request_id: randomUUID(), created_at: now, expires_at: now + 300000,
    tab, session: session || null, binding_key: bindingKey,
    action_digest: digest(payload, bindingKey), scope_digest: digest(scope, bindingKey),
  };
}

export function checkActionConfirmation({ request, requestId, userConfirmed, payload, scope, tab, session, now = Date.now() }) {
  if (userConfirmed !== true) return { ok: false, reason: 'explicit_user_confirmation_required' };
  if (!request || request.request_id !== requestId || typeof request.binding_key !== 'string') return { ok: false, reason: 'confirmation_not_found' };
  if (!Number.isFinite(request.expires_at) || now >= request.expires_at) return { ok: false, reason: 'confirmation_expired' };
  if (request.tab !== tab || request.session !== (session || null)) return { ok: false, reason: 'confirmation_target_changed' };
  if (request.action_digest !== digest(payload, request.binding_key)) return { ok: false, reason: 'confirmation_action_changed' };
  if (scope !== undefined && request.scope_digest !== digest(scope, request.binding_key)) return { ok: false, reason: 'confirmation_page_changed' };
  return { ok: true };
}

export function publicActionConfirmation(request) {
  return { request_id: request.request_id, created_at: request.created_at, expires_at: request.expires_at,
    tab: request.tab, single_use: true };
}
