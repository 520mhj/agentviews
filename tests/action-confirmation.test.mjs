import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionConfirmation, checkActionConfirmation, publicActionConfirmation } from '../src/core/action-confirmation.mjs';

const payload = { name: 'Commit changes', role: 'button', verb: 'click' };
const scope = JSON.stringify({ document: 'doc1', target: 'target-1', url: 'https://example.com', fields: [] });
const context = { payload, scope, tab: '20', session: 'browser1', now: 1000 };

test('confirmation is bounded, single-action and does not store raw inputs or page bodies', () => {
  const request = createActionConfirmation({ ...context, payload: { ...payload, text: 'private-value' } });
  assert.equal(request.expires_at, 301000);
  assert.equal(JSON.stringify(request).includes('private-value'), false);
  assert.equal(JSON.stringify(request).includes('https://example.com'), false);
  const publicRequest = publicActionConfirmation(request);
  assert.equal(publicRequest.single_use, true);
  assert.equal(publicRequest.binding_key, undefined);
  assert.equal(publicRequest.action_digest, undefined);
});

test('explicit user confirmation is required and tied to action, page, session, tab and expiry', () => {
  const request = createActionConfirmation(context);
  const attempt = { ...context, request, requestId: request.request_id, userConfirmed: true, now: 2000 };
  assert.equal(checkActionConfirmation(attempt).ok, true);
  assert.equal(checkActionConfirmation({ ...attempt, payload: { role: 'button', verb: 'click', name: 'Commit changes' } }).ok, true);
  for (const [changes, reason] of [
    [{ userConfirmed: undefined }, 'explicit_user_confirmation_required'],
    [{ userConfirmed: 'true' }, 'explicit_user_confirmation_required'],
    [{ requestId: 'other' }, 'confirmation_not_found'],
    [{ request: null }, 'confirmation_not_found'],
    [{ tab: '21' }, 'confirmation_target_changed'],
    [{ session: 'browser2' }, 'confirmation_target_changed'],
    [{ payload: { ...payload, name: 'Delete repository' } }, 'confirmation_action_changed'],
    [{ scope: scope + 'changed' }, 'confirmation_page_changed'],
    [{ now: 301000 }, 'confirmation_expired'],
  ]) assert.equal(checkActionConfirmation({ ...attempt, ...changes }).reason, reason);
});

test('text and choice changes cannot reuse an approved request', () => {
  for (const original of [{ ...payload, text: 'approved' }, { ...payload, checked: true }, { ...payload, option: 'A' }]) {
    const request = createActionConfirmation({ ...context, payload: original });
    for (const changed of [{ ...original, text: 'changed' }, { ...original, checked: false }, { ...original, option: 'B' }]) {
      assert.equal(checkActionConfirmation({ ...context, request, requestId: request.request_id, userConfirmed: true, payload: changed }).reason, 'confirmation_action_changed');
    }
  }
});
