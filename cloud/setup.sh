#!/usr/bin/env bash
#
# One-command cloud Home Assistant setup for the Balboa spa module.
#
#   curl -sSL https://raw.githubusercontent.com/kgstorm/Balboa-GS100-with-VL260-topside/main/cloud/setup.sh | sudo bash
#
# Installs Docker, issues a Let's Encrypt certificate via DuckDNS, and starts
# Home Assistant + Mosquitto (MQTT) + Caddy (HTTPS) with Docker Compose.
# Tested on Ubuntu 22.04/24.04 (Oracle Cloud Always Free ARM VM).

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/kgstorm/Balboa-GS100-with-VL260-topside/main/cloud"
INSTALL_DIR="${SPA_CLOUD_DIR:-/opt/spa-cloud}"

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33mWARNING:\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Preconditions -----------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Please run as root: curl ... | sudo bash"

if ! command -v apt-get >/dev/null 2>&1; then
  die "This script supports Ubuntu/Debian (apt-get) only."
fi

# Prompts must work even when the script is piped through curl. Values can
# also be supplied non-interactively as environment variables, e.g.:
#   sudo DUCKDNS_SUBDOMAIN=myspa DUCKDNS_TOKEN=... bash setup.sh
prompt() {
  local var="$1" text="$2" value
  value="${!var:-}"
  if [ -z "$value" ]; then
    read -r -p "$text" value < /dev/tty
  fi
  [ -n "$value" ] || die "No value entered for $var."
  printf -v "$var" '%s' "$value"
}

# --- Gather settings ---------------------------------------------------------

info "DuckDNS provides the free hostname your spa module will connect to."
info "Create one first at https://www.duckdns.org (sign in, add a subdomain)."
echo
prompt DUCKDNS_SUBDOMAIN "DuckDNS subdomain (e.g. 'myspa' for myspa.duckdns.org): "
prompt DUCKDNS_TOKEN     "DuckDNS token (shown at the top of the DuckDNS page): "

DOMAIN="${DUCKDNS_SUBDOMAIN}.duckdns.org"

# --- Docker ------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin missing; please install docker-compose-plugin."

# Oracle Cloud Ubuntu images ship an iptables FORWARD chain that ends in a
# blanket REJECT, which kills inbound traffic to Docker's published ports
# even though Docker inserts its own ACCEPT rules earlier in the chain.
# Allow established/related traffic and the ports this stack publishes.
# (Inbound ports must also be opened in the OCI Security List - see the guide.)
if iptables -L FORWARD -n 2>/dev/null | grep -q "reject-with icmp-host-prohibited"; then
  info "Adjusting host firewall (FORWARD chain) for Docker published ports..."
  iptables -I FORWARD 1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -I FORWARD 2 -p tcp -m multiport --dports 80,443,8883 -j ACCEPT
fi

# --- Install directory -------------------------------------------------------

# When run from a local checkout (sudo bash cloud/setup.sh), use those files;
# when piped through curl, download them from the repo instead.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

mkdir -p "$INSTALL_DIR"/{mosquitto/data,homeassistant,acme,certs}

if [ -n "${SCRIPT_DIR:-}" ] && [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ -f "$SCRIPT_DIR/mosquitto.conf" ]; then
  info "Using local bundle files from $SCRIPT_DIR"
  cp "$SCRIPT_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
  cp "$SCRIPT_DIR/mosquitto.conf" "$INSTALL_DIR/mosquitto/mosquitto.conf"
else
  info "Downloading bundle files..."
  curl -fsSL "$REPO_RAW/docker-compose.yml" -o "$INSTALL_DIR/docker-compose.yml"
  curl -fsSL "$REPO_RAW/mosquitto.conf" -o "$INSTALL_DIR/mosquitto/mosquitto.conf"
fi
cd "$INSTALL_DIR"

# --- DuckDNS: point the domain at this VM, keep it fresh ---------------------

info "Pointing $DOMAIN at this server's public IP..."
curl -fsSL "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=" | grep -q OK \
  || die "DuckDNS update failed - check the subdomain and token."

cat > /etc/cron.d/spa-duckdns <<EOF
*/5 * * * * root curl -fsSL "https://www.duckdns.org/update?domains=${DUCKDNS_SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=" >/dev/null 2>&1
EOF

# --- MQTT credentials ---------------------------------------------------------

if [ -f mosquitto/passwords ] && [ -f .env ] && grep -q '^MQTT_PASSWORD=.' .env; then
  info "Keeping existing MQTT credentials."
  MQTT_PASSWORD="$(grep '^MQTT_PASSWORD=' .env | cut -d= -f2-)"
else
  command -v python3 >/dev/null 2>&1 || die "Python 3 is required to generate an MQTT password."
  MQTT_PASSWORD="$(python3 - <<'PY'
import secrets
import string

characters = [secrets.choice(string.ascii_lowercase) for _ in range(12)]
uppercase_position = secrets.randbelow(12)
digit_position = secrets.randbelow(11)
if digit_position >= uppercase_position:
    digit_position += 1
characters[uppercase_position] = secrets.choice(string.ascii_uppercase)
characters[digit_position] = secrets.choice(string.digits)
print("".join(characters[:6]) + "-" + "".join(characters[6:]))
PY
)"
  info "Creating MQTT user 'spa'..."
  docker run --rm -v "$INSTALL_DIR/mosquitto:/mosquitto/config" eclipse-mosquitto:2 \
    mosquitto_passwd -c -b /mosquitto/config/passwords spa "$MQTT_PASSWORD" >/dev/null
  # mosquitto_passwd creates the file root:root 600; the broker runs as
  # uid 1883 and must be able to read it.
  chmod 644 mosquitto/passwords
fi

cat > .env <<EOF
DOMAIN=$DOMAIN
DUCKDNS_TOKEN=$DUCKDNS_TOKEN
MQTT_USERNAME=spa
MQTT_PASSWORD=$MQTT_PASSWORD
EOF
chmod 600 .env

# --- Home Assistant seed config ----------------------------------------------

if [ ! -f homeassistant/configuration.yaml ]; then
  info "Writing initial Home Assistant configuration..."
  cat > homeassistant/configuration.yaml <<'EOF'
# Loads the default set of integrations (frontend, history, etc.)
default_config:
EOF
fi

# Home Assistant must trust the Caddy reverse proxy from the very first
# request. Since HA 2026.x, an `http:` block in configuration.yaml is migrated
# into storage as a "pending" config that requires confirmation in the web UI -
# which is unreachable until the proxy is trusted (chicken-and-egg). So instead
# we pre-seed HA's private http storage with the proxy config already in the
# confirmed "stable" slot, before HA ever starts.
if [ ! -f homeassistant/.storage/http ]; then
  info "Pre-seeding Home Assistant reverse-proxy trust..."
  mkdir -p homeassistant/.storage
  cat > homeassistant/.storage/http <<'EOF'
{
  "version": 3,
  "minor_version": 1,
  "key": "http",
  "data": {
    "stable": {
      "server_port": 8123,
      "use_x_forwarded_for": true,
      "trusted_proxies": ["172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"],
      "cors_allowed_origins": ["https://cast.home-assistant.io"],
      "login_attempts_threshold": -1,
      "ip_ban_enabled": true,
      "ssl_profile": "intermediate_v6",
      "use_x_frame_options": true,
      "created_at": "2026-01-01T00:00:00+00:00",
      "error": null,
      "error_message": null
    },
    "pending": null,
    "yaml_migration_done": true
  }
}
EOF
fi

# --- Caddyfile ----------------------------------------------------------------

cat > Caddyfile <<EOF
$DOMAIN {
	tls /certs/fullchain.pem /certs/key.pem
	reverse_proxy homeassistant:8123
}
EOF

# --- TLS certificate (Let's Encrypt via DuckDNS DNS) --------------------------

if [ -s certs/fullchain.pem ] && [ -s certs/key.pem ]; then
  info "Keeping existing certificate."
else
  info "Issuing Let's Encrypt certificate for $DOMAIN (takes about a minute)..."
  docker run --rm \
    -v "$INSTALL_DIR/acme:/acme.sh" \
    -e DuckDNS_Token="$DUCKDNS_TOKEN" \
    neilpang/acme.sh:latest \
    --issue --dns dns_duckdns -d "$DOMAIN" --server letsencrypt

  # Install the cert into the shared certs/ volume. The reloadcmd is persisted
  # by acme.sh and re-run by the renewal daemon (which has the docker socket
  # mounted) after every renewal: it refreshes the cert files and restarts the
  # containers that use them. It must not fail when run during this initial
  # install, where the socket and containers don't exist yet.
  docker run --rm \
    -v "$INSTALL_DIR/acme:/acme.sh" \
    -v "$INSTALL_DIR/certs:/certs" \
    neilpang/acme.sh:latest \
    --install-cert -d "$DOMAIN" \
    --fullchain-file /certs/fullchain.pem \
    --key-file /certs/key.pem \
    --reloadcmd "chmod 644 /certs/key.pem /certs/fullchain.pem; if [ -S /var/run/docker.sock ]; then curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/containers/mosquitto/restart; curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/containers/caddy/restart; fi; true"
fi

# --- Start everything ----------------------------------------------------------

info "Starting services..."
docker compose up -d

# --- Summary -------------------------------------------------------------------

MQTT_PASSWORD="$(grep '^MQTT_PASSWORD=' .env | cut -d= -f2-)"

cat <<EOF

================================================================
 Setup complete!

 Home Assistant:  https://$DOMAIN
   1. Open it and create your admin account.
   2. Go to Settings > Devices & services > Add integration
      > MQTT and enter:
        Broker:   mosquitto
        Port:     1883
        Username: spa
        Password: (the one below)

 Spa module MQTT settings
 (enter these on the module's setup hotspot page):
   Broker:   $DOMAIN
   Port:     8883
   Username: spa
   Password: $MQTT_PASSWORD

 These credentials are also stored in $INSTALL_DIR/.env
================================================================
EOF
