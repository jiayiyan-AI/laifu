# Cloud Drive P4+P5 — Manual End-to-End Verification

## Prereqs

- `supabase start --workdir infra` running (db on 127.0.0.1:54322)
- `apps/gateway/.env.local` has SUPABASE_*, GOOGLE_*, AZURE_STORAGE_* set
- `pnpm dev` running (hermes + gateway + web)
- Browser logged in to the web app via Google OAuth

## Happy path (with mock container observed)

1. Open <http://localhost:3000/desktop>
2. Open "我的助理" (Manage app)
3. Scroll to "功能 / 订阅" section
4. Click "☁️ 启用云盘" button
5. Modal opens — first shows "正在记录权益…", then "助理重启中…"
6. **Local-dev limitation**: the gateway runs the local provisioner mock, which doesn't actually restart a real container. So `container_observed_state` won't auto-update. You need to simulate the container reporting back observed entitlements manually.

### Simulate container observed report

In a separate terminal:

```bash
# Get your user_id from supabase
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "SELECT id, email FROM users;"

# Set the UUID
USER_ID=<paste your uuid here>

# Upsert observed state for that user
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "INSERT INTO container_observed_state (user_id, observed_entitlements, observed_token_version) \
   VALUES ('$USER_ID', ARRAY['cloud'], 1) \
   ON CONFLICT (user_id) DO UPDATE SET observed_entitlements = ARRAY['cloud'], observed_token_version = 1, reported_at = NOW();"
```

7. Within ~2s the web Modal detects observed → closes → Dock shows ☁️ Files icon → Files App auto-opens (because Desktop has a `useEffect` watching the entitlement flip)
8. Files App initially shows "还没有文件 · 让助理把成果发布到云盘" (no blobs uploaded yet — P3 will add the publish capability)

## Verifying just the Files App without enable flow

Once observed has `cloud`, refreshing the browser shows ☁️ Files in the Dock immediately. Clicking it opens the Files App. Empty state until P3 lands.

## Disable flow (no UI yet)

Disable currently has no UI button. Use curl with session cookie:

```bash
# Get your session cookie from browser DevTools (Application → Cookies → lingxi_sid)
SID=<paste here>
curl -X POST http://localhost:9000/api/entitlements/cloud/disable \
  -H "Cookie: lingxi_sid=$SID"
```

Or directly via psql:

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "UPDATE user_entitlements SET disabled_at=NOW() WHERE user_id='$USER_ID' AND feature='cloud' AND disabled_at IS NULL;"

# Also clear observed to reflect the change
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c \
  "UPDATE container_observed_state SET observed_entitlements='{}' WHERE user_id='$USER_ID';"
```

After refreshing the browser, ☁️ Files disappears from Dock and the ManageApp button reverts to "启用云盘".

## Known limitations

| Item | Why | When fixed |
|---|---|---|
| Auto-restart container on enable | local provisioner is mock | P7 / Azure deploy |
| Container reports observed back | no real container runs the entrypoint | P3 actual container + Azure |
| Files App shows uploaded files | no publish CLI exists yet | P3 cloud-publish skill |
| PDF/image preview in Files App | embedded preview UI not implemented | P6 |
| Disable button in ManageApp UI | only enable button done in P5 | P6 settings polish |
