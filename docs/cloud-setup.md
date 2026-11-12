# Cloud Home Assistant Setup (No Local Home Assistant Required)

This guide is for spa module owners who **don't already run Home Assistant at home**.
You will run Home Assistant on a **free Oracle Cloud server** and connect your spa
module to it securely over MQTT (TLS). Everything below is free — no trial expiry.

**What you end up with:**

- Home Assistant reachable at `https://<yourname>.duckdns.org` from your phone/browser
- Your spa module sending temperature/status and receiving commands over an
  encrypted (TLS) MQTT connection
- No router port forwarding is needed: the module makes an *outgoing* cloud
  connection. Its setup page is also available on your home network.

**Time required:** about 30–45 minutes, mostly clicking through web pages.

---

## Step 1 — Create an Oracle Cloud account

1. Go to <https://www.oracle.com/cloud/free/> and click **Start for free**.
2. Sign up. Oracle asks for a credit card for identity verification — the
   **Always Free** resources we use are never charged.
3. **Tip:** the free ARM VMs are sometimes shown as "out of capacity" for
   brand-new accounts that only use the free tier. Adding a payment method
   (becoming a "potential paying customer") reliably makes capacity available,
   even though you stay on the free tier.

## Step 2 — Create the free VM

1. In the Oracle Cloud console, open **Compute → Instances → Create instance**.
2. **Name:** anything, e.g. `spa-ha`.
3. **Image:** Ubuntu 24.04 (aarch64) — the default Ubuntu is fine.
4. **Shape:** click **Change shape → Ampere → VM.Standard.A1.Flex**.
   1 OCPU and 6 GB RAM is plenty (you can use up to 4 OCPU / 24 GB free).
5. **Networking:** keep the defaults; make sure **Assign a public IPv4 address** is selected.
6. **SSH keys:** choose **Generate a key pair for me** and **download the private key**
   — you need it to log in.
7. Click **Create**. Wait until the instance shows **Running** and note its
   **Public IP address**.

## Step 3 — Open the firewall ports

Oracle blocks inbound ports by default. Open the three we need:

1. On the instance page, open the **Networking** tab and click the **Subnet** link.
2. In the subnet, open the **Security** tab and click the **Default Security List**.
3. Open the **Security rules** tab → **Add Ingress Rules**. Add these three rules,
   leaving the **Source CIDR** empty (it defaults to `0.0.0.0/0`, i.e. anywhere)
   and "Stateless" unchecked:

   | Destination Port | Protocol | Purpose |
   |---|---|---|
   | 80 | TCP | Certificate + redirect to HTTPS |
   | 443 | TCP | Home Assistant web UI (HTTPS) |
   | 8883 | TCP | Spa module (MQTT over TLS) |

   (Port 22 for SSH is already open.)

## Step 4 — Create a free hostname (DuckDNS)

The module needs a stable name to connect to (required for TLS certificates).

1. Go to <https://www.duckdns.org> and sign in (Google/GitHub/etc.).
2. Under **Domains**, pick a subdomain, e.g. `myname-spa` → **add domain**.
3. Leave the IP field alone for now — the setup script sets it automatically.
4. Note your **subdomain** and the **token** shown at the top of the page.

## Step 5 — Run the setup script

1. SSH into the VM. On Windows use PowerShell, on Mac/Linux use Terminal:

   ```bash
   ssh -i /path/to/ssh-key.key ubuntu@<PUBLIC_IP>
   ```

   If SSH reports **"UNPROTECTED PRIVATE KEY FILE"**, restrict access to your
   private key, then retry the SSH command. Replace the example path with the
   path to your downloaded key:

   - **Mac/Linux (Terminal):**

     ```bash
     chmod 600 /path/to/ssh-key.key
     ```

   - **Windows (PowerShell):**

     ```powershell
     icacls "C:\path\to\ssh-key.key" /inheritance:r /grant:r "${env:USERNAME}:(R)"
     icacls "C:\path\to\ssh-key.key"
     ```

     The second command displays the remaining permissions. If other users or
     groups still have explicit access, remove those entries using Windows file
     security settings before retrying. Do not share the private key.

2. Run one command:

   ```bash
   curl -sSL https://raw.githubusercontent.com/kgstorm/Balboa-GS100-with-VL260-topside/main/cloud/setup.sh | sudo bash
   ```

3. When prompted, paste your DuckDNS **subdomain** and **token**.
4. Wait a few minutes (Docker install + certificate issuance). At the end the
   script prints a summary like:

   ```
   Spa module MQTT settings:
     Broker:   myname-spa.duckdns.org
     Port:     8883
     Username: spa
     Password: abcDef-ghij2k
   ```

   The password shown above is an example, not your password. New passwords
   contain two groups of six characters, with one uppercase letter and one
   digit. Existing MQTT credentials are retained when the installer is rerun.
   **Keep your output** — you need it in the next steps. It is also saved in
   `/opt/spa-cloud/.env` on the server.

## Step 6 — Set up Home Assistant

1. Open `https://<your-subdomain>.duckdns.org` in your browser.
2. Create your admin account — **use a strong password** (this page is reachable
   from the internet). Afterwards, enable Multi-factor Authentication:
   click your username (bottom left) → **Security** → **Multifactor Authentication**
   → TOTP.
3. Go to **Settings → Devices & services → Add integration → MQTT** and enter:
   - **Broker:** `mosquitto`
   - **Port:** `1883`
   - **Username / Password:** the `spa` credentials from the setup script output.

## Step 7 — Connect the spa module

1. Power up the spa module. Since it doesn't know your WiFi yet, after about a
   minute it broadcasts a hotspot named **Esp32-Spa Fallback Hotspot**.
2. Connect your phone to that hotspot (password: the AP password included with
   your module / from your `secrets.yaml`).
3. The captive-portal setup page should open automatically. If it does not,
   open `http://192.168.4.1` in your browser while connected to the hotspot.
4. Fill in the form:
   - Choose a visible **home WiFi** network or enter its name manually, and
     enter its password. Select the open-network checkbox only if it has no password.
   - Select **"In the cloud / I don't have it yet"**
   - Enter the **Broker, Port, Username, Password** from the setup script output
5. Tap **Save & restart** and wait for confirmation. The module joins your WiFi
   and connects to your cloud server.
6. Within a minute, find the `esp32-spa` device under **Settings → Devices &
   services → MQTT → Devices**. MQTT discovery may add it there automatically,
   rather than showing a separate **Discovered** tile.
   If an older firmware advertised an ESPHome integration for the same module,
   dismiss that discovery: cloud Home Assistant cannot directly reach the
   module's private home-network address.

## Step 8 — Add the spa control card

1. On the VM, install the card file:

   ```bash
   sudo mkdir -p /opt/spa-cloud/homeassistant/www
   sudo curl -sSL -o /opt/spa-cloud/homeassistant/www/spa-control-card.js \
     https://raw.githubusercontent.com/kgstorm/Balboa-GS100-with-VL260-topside/main/dist/spa-control-card.js
   ```

2. In Home Assistant, go to **Settings** → **Dashboards** → three-dot menu →
   **Resources**, then select **Add resource**:
   - **URL:** `/local/spa-control-card.js`
   - **Resource type:** JavaScript Module
3. Create a dashboard: go to **Settings** → **Dashboards** → **Add dashboard** →
   **New dashboard from scratch**:
   - **Title:** Spa
4. Add the card to the dashboard (see the [README](../README.md#frontend) for the
   card YAML). Use `esp32-spa` as the device name.

---

## Security notes

- **Module → cloud:** TLS-encrypted MQTT on port 8883 with a per-install random
  password. The shorter, easy-to-type password has less entropy than the
  previously generated 32-character hexadecimal password. The module verifies
  the server's Let's Encrypt certificate.
- **Web UI:** HTTPS only (Caddy). Protect it with a strong password + TOTP MFA.
- **SSH:** key-only access (Oracle default). Consider restricting port 22 to your
  own IP in the Security List.
- **Local setup page:** the module serves plain HTTP on your home network, with
  the shared fixed username `spa` and password `balboawifi`. Anyone who knows
  these credentials and can reach the module can change its settings. HTTP does
  not encrypt the password or MQTT credentials. Use only on a trusted network;
  never forward its port or expose it to the internet.

## FAQ

**What does this cost?** Nothing ongoing. Oracle's Ampere A1 VM (up to 4 OCPU /
24 GB RAM), the public IP, and the bandwidth are all Always Free. DuckDNS and
Let's Encrypt are free.

**What if my home internet goes down?** The spa keeps working normally from its
physical topside panel. App control resumes when the internet is back.

**How do I correct MQTT settings?** While connected to the same home network as
the module, open `http://esp32-spa.local/` or enter the private IP address of the module found in your routers software, then sign in with username `spa` and
password `balboawifi`, and edit the settings. If the name does not resolve, find the
module's IP address in your router's connected-device list and open
`http://<module-ip>/` instead. A blank MQTT password retains the saved password;
enter a new one to replace it. The page shows connection status, but not every
connection failure can be diagnosed precisely; check the device logs for details.

**How do I change WiFi?** Use the fallback hotspot as described above, and
uncheck **Keep the current WiFi settings**. Enter the new network and password.
For the same saved network, a blank password attempts to keep the saved one; if
the module cannot identify the saved network, enter the password again. For a
network without a password, explicitly select the open-network checkbox.

**I lost my MQTT credentials.** They're saved on the VM server. SSH in and run
`sudo cat /opt/spa-cloud/.env` — the username and password are in there.

**What if the VM's public IP changes?** The setup script installed a small cron
job that keeps DuckDNS pointed at the current IP, so things heal themselves
within ~5 minutes. (You can also reserve a static free IP in Oracle: instance →
**Attached VNICs** → **Public IP** → **Reserved public IP**.)

**Can I move to local Home Assistant later?** Yes — open the local setup page
or use the fallback hotspot and choose **"On my home network"**. No reflash needed.

**Where are the files on the server?** Everything lives in `/opt/spa-cloud`:
`docker-compose.yml`, Home Assistant config in `homeassistant/`, MQTT data in
`mosquitto/`, certificates in `certs/`. Manage with
`sudo docker compose -f /opt/spa-cloud/docker-compose.yml ...`.
