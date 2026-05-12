// Centralized client-identification strings so Lurker shows up as itself when
// it talks to the outside world — image hosts in HTTP User-Agent, IRC peers
// via CTCP VERSION. Admins can override the contact portion with the
// USER_AGENT_CONTACT env var so a service operator who wants to flag a
// misbehaving Lurker can reach the deployment's owner instead of the upstream
// project.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));

const DEFAULT_CONTACT = 'https://github.com/amiantos/caint';
const contact = (process.env.USER_AGENT_CONTACT || DEFAULT_CONTACT).trim();

export const APP_NAME = 'Lurker';
export const APP_VERSION = pkg.version;

// Used as the HTTP User-Agent header on outbound requests to upload providers
// and any future external service. Format follows the conventional
// `Name/Version (+contact)` shape that's friendly to log scanners.
export const USER_AGENT = contact
  ? `${APP_NAME}/${APP_VERSION} (+${contact})`
  : `${APP_NAME}/${APP_VERSION}`;

// Used as the CTCP VERSION reply on IRC. Same idea, but IRC clients typically
// don't show the contact, so keep it terse.
export const IRC_VERSION = contact
  ? `${APP_NAME} ${APP_VERSION} - ${contact}`
  : `${APP_NAME} ${APP_VERSION}`;
