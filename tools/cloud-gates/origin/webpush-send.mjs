/**
 * Web Push sender: sends one standard VAPID Web Push message for gate G5.
 *
 * G5 asks whether the Play build's embedded FCM distributor accepts plain RFC 8030 / RFC 8291
 * Web Push with VAPID and no publisher FCM credentials. This script is the publisher side:
 * it encrypts and posts one message with the `web-push` library and prints the push
 * service's answer. `--generate` mints a VAPID key pair for the operator.
 *
 * - Subscription and VAPID material is read only from the environment, never from argv.
 * - Never prints the endpoint (it embeds the device token) or any key; `--generate` is the
 *   one deliberate exception, and its caller redacts the private key before recording.
 * - Exit 0 on a 2xx answer, 1 on any other answer or failure, 2 on missing configuration.
 *
 * <module-headers:begin>
 * Uses: none
 * External: web-push
 *
 * Used by: entry point (node webpush-send.mjs, run by tools/cloud-gates/g05-embedded-fcm.sh)
 * <module-headers:end>
 */
import webpush from 'web-push';

const HEADER_SUBSET = ['content-type', 'location', 'retry-after', 'ttl', 'link', 'urgency'];

function finish(obj, code) {
  process.stdout.write(`${JSON.stringify(obj)}\n`, () => process.exit(code));
}

function describe(statusCode, body, headers) {
  const subset = {};
  for (const name of HEADER_SUBSET) {
    if (headers && headers[name] !== undefined) subset[name] = headers[name];
  }
  return { statusCode, body: String(body ?? '').slice(0, 300), headers: subset };
}

if (process.argv.includes('--generate')) {
  finish(webpush.generateVAPIDKeys(), 0);
} else {
  const env = process.env;
  const required = ['WP_ENDPOINT', 'WP_P256DH', 'WP_AUTH', 'WP_VAPID_PUBLIC', 'WP_VAPID_PRIVATE'];
  const missing = required.filter((name) => !env[name]);
  const ttl = Number(env.WP_TTL ?? 60);
  if (missing.length || !Number.isInteger(ttl) || ttl < 0) {
    process.stderr.write(
      missing.length ? `missing environment variables: ${missing.join(', ')}\n` : 'WP_TTL must be a non-negative integer\n',
    );
    process.exit(2);
  }
  const subscription = { endpoint: env.WP_ENDPOINT, keys: { p256dh: env.WP_P256DH, auth: env.WP_AUTH } };
  const options = {
    TTL: ttl,
    urgency: env.WP_URGENCY || 'high',
    vapidDetails: {
      subject: env.WP_VAPID_SUBJECT || 'mailto:gate@example.invalid',
      publicKey: env.WP_VAPID_PUBLIC,
      privateKey: env.WP_VAPID_PRIVATE,
    },
  };
  try {
    const res = await webpush.sendNotification(subscription, env.WP_PAYLOAD ?? '{"t":"gate"}', options);
    finish(describe(res.statusCode, res.body, res.headers), res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  } catch (err) {
    if (err instanceof webpush.WebPushError) {
      finish(describe(err.statusCode, err.body, err.headers), 1);
    } else {
      finish({ statusCode: null, error: err instanceof Error ? err.message : String(err) }, 1);
    }
  }
}
