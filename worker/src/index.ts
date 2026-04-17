/**
 * recgovme — Cloudflare Worker
 *
 * Polls Recreation.gov every 5 minutes for cabin cancellation openings.
 * Reads watches from Supabase, diffs availability against KV state,
 * and emails users via Resend when their watched dates open up.
 */

// ── Types ────────────────────────────────────────────────────────────────────

interface Env {
  STATE: KVNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  WORKER_URL: string;
}

interface Watch {
  id: string;
  email: string;
  facility_id: string;
  facility_name: string;
  dates: string[];
  days_of_week: string[]; // e.g. ["fri","sat"] or [] for all days
  unsubscribe_token: string;
}

interface SiteAvailability {
  [date: string]: string; // "Available", "Reserved", "Not Available", etc.
}

interface Opening {
  watch: Watch;
  date: string;
  facilityName: string;
  facilityId: string;
}

// ── Recreation.gov API ───────────────────────────────────────────────────────

const RECGOV_HEADERS: HeadersInit = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.recreation.gov/",
  Origin: "https://www.recreation.gov",
  "Cache-Control": "no-cache",
};

async function fetchCampgroundMonth(
  facilityId: string,
  year: number,
  month: number
): Promise<SiteAvailability> {
  const startDate = `${year}-${String(month).padStart(2, "0")}-01T00:00:00.000Z`;
  const url = `https://www.recreation.gov/api/camps/availability/campground/${facilityId}/month?start_date=${encodeURIComponent(startDate)}`;

  const resp = await fetch(url, { headers: RECGOV_HEADERS });
  if (!resp.ok) {
    console.error(`API ${resp.status} for facility ${facilityId} month ${year}-${month}`);
    return {};
  }

  const data: any = await resp.json();
  return parseCampgroundAvailability(data);
}

function parseCampgroundAvailability(raw: any): SiteAvailability {
  const result: SiteAvailability = {};
  const campsites = raw?.campsites;
  if (!campsites) return result;

  // Alaska USFS cabins typically have 1 campsite per facility.
  // Merge all sites — if ANY site is available on a date, mark it available.
  for (const site of Object.values(campsites) as any[]) {
    const avail = site?.availabilities;
    if (!avail) continue;

    for (const [dateKey, status] of Object.entries(avail) as [string, string][]) {
      const date = parseDateKey(dateKey);
      if (!date) continue;

      // "Available" wins over any other status
      if (status === "Available" || result[date] === undefined) {
        result[date] = status;
      }
    }
  }

  return result;
}

function parseDateKey(key: string): string | null {
  if (!key) return null;
  if (key.length === 10 && key[4] === "-" && key[7] === "-") return key;
  if (key.includes("T")) return key.slice(0, 10);
  return null;
}

/** Fetch availability across all months that any watch cares about. */
async function fetchFacilityAvailability(
  facilityId: string,
  months: Set<string> // "2026-06", "2026-07", etc.
): Promise<SiteAvailability> {
  const all: SiteAvailability = {};

  for (const ym of [...months].sort()) {
    const [yearStr, monthStr] = ym.split("-");
    await sleep(200 + Math.random() * 600);
    const monthData = await fetchCampgroundMonth(facilityId, parseInt(yearStr), parseInt(monthStr));
    Object.assign(all, monthData);
  }

  return all;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function fetchActiveWatches(env: Env): Promise<Watch[]> {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/watches?active=eq.true&select=id,email,facility_id,facility_name,dates,days_of_week,unsubscribe_token`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!resp.ok) {
    console.error(`Supabase fetch failed: ${resp.status} ${await resp.text()}`);
    return [];
  }

  return resp.json();
}

async function recordNotification(
  env: Env,
  watchId: string,
  dateFound: string
): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/rest/v1/notifications`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates",
    },
    body: JSON.stringify({ watch_id: watchId, date_found: dateFound }),
  });
}

async function getNotifiedDates(env: Env, watchIds: string[]): Promise<Set<string>> {
  // Fetch all notifications for these watches to avoid re-alerting
  const idsFilter = watchIds.map((id) => `"${id}"`).join(",");
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/notifications?watch_id=in.(${idsFilter})&select=watch_id,date_found`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!resp.ok) return new Set();
  const rows: { watch_id: string; date_found: string }[] = await resp.json();
  return new Set(rows.map((r) => `${r.watch_id}:${r.date_found}`));
}

// ── Change detection ─────────────────────────────────────────────────────────

const DAY_MAP: Record<number, string> = {
  0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat",
};

function matchesDayFilter(dateStr: string, daysOfWeek: string[]): boolean {
  // Empty array = all days
  if (!daysOfWeek || daysOfWeek.length === 0) return true;
  const d = new Date(dateStr + "T12:00:00Z");
  const dayName = DAY_MAP[d.getUTCDay()];
  return daysOfWeek.includes(dayName);
}

function findOpenings(
  watches: Watch[],
  availability: SiteAvailability,
  previous: SiteAvailability,
  notifiedSet: Set<string>
): Opening[] {
  const openings: Opening[] = [];

  for (const watch of watches) {
    for (const date of watch.dates) {
      // Skip if this date's day of week isn't in the filter
      if (!matchesDayFilter(date, watch.days_of_week)) continue;

      const curr = availability[date];
      const prev = previous[date];

      // New opening: currently available AND wasn't available before
      if (curr === "Available" && prev !== "Available") {
        // Skip if we already notified for this watch+date
        if (notifiedSet.has(`${watch.id}:${date}`)) continue;
        openings.push({
          watch,
          date,
          facilityName: watch.facility_name,
          facilityId: watch.facility_id,
        });
      }
    }
  }

  return openings;
}

// ── Email notifications ──────────────────────────────────────────────────────

function formatEmailHtml(openings: Opening[], unsubToken: string, workerUrl: string): string {
  let html = `<html><body style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
    <h2 style="color: #1a5c2e;">Cabin Opening Found!</h2>
    <p style="color: #666;">Detected at: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</p>`;

  for (const o of openings) {
    const d = new Date(o.date + "T12:00:00Z");
    const fmt = d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });

    html += `<div style="margin: 16px 0; padding: 16px; background: #f0f7f2; border-radius: 8px;">
      <strong style="font-size: 18px;">${o.facilityName}</strong><br/>
      <span style="font-size: 16px; color: #1a5c2e;">${fmt}</span><br/>
      <a href="https://www.recreation.gov/camping/campgrounds/${o.facilityId}"
        style="display: inline-block; margin-top: 12px; padding: 10px 20px;
        background: #1a5c2e; color: white; text-decoration: none; border-radius: 5px;">
        Book Now on Recreation.gov</a>
    </div>`;
  }

  html += `<p style="color: #cc0000; font-weight: bold;">Act fast — cabin cancellations go quickly!</p>`;
  html += `<hr style="border: none; border-top: 1px solid #ddd; margin: 24px 0;"/>`;
  html += `<p style="color: #999; font-size: 12px;">
    <a href="${workerUrl}/unsubscribe?token=${unsubToken}" style="color: #999;">Unsubscribe</a>
    from this watch</p>`;
  html += `</body></html>`;
  return html;
}

async function sendEmail(
  env: Env,
  email: string,
  openings: Opening[],
  unsubToken: string
): Promise<boolean> {
  const cabinNames = [...new Set(openings.map((o) => o.facilityName))];
  const subject = `Cabin Alert: ${openings.length} opening(s) — ${cabinNames.join(", ")}`;
  const html = formatEmailHtml(openings, unsubToken, env.WORKER_URL);

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || "recgov.me <alerts@recgov.me>",
        to: [email],
        subject,
        html,
      }),
    });

    if (!resp.ok) {
      console.error(`Resend failed for ${email}: ${resp.status} ${await resp.text()}`);
      return false;
    }
    console.log(`Email sent to ${email}`);
    return true;
  } catch (e) {
    console.error(`Email error for ${email}:`, e);
    return false;
  }
}

// ── Main check logic ─────────────────────────────────────────────────────────

async function checkCabins(env: Env): Promise<string> {
  const watches = await fetchActiveWatches(env);
  if (watches.length === 0) {
    console.log("No active watches");
    return "No active watches";
  }
  console.log(`${watches.length} active watch(es)`);

  // Group watches by facility_id
  const byFacility = new Map<string, Watch[]>();
  for (const w of watches) {
    const existing = byFacility.get(w.facility_id) || [];
    existing.push(w);
    byFacility.set(w.facility_id, existing);
  }

  // Collect all watch IDs for notification dedup
  const allWatchIds = watches.map((w) => w.id);
  const notifiedSet = await getNotifiedDates(env, allWatchIds);

  let totalOpenings = 0;

  for (const [facilityId, facilityWatches] of byFacility) {
    const facilityName = facilityWatches[0].facility_name;
    console.log(`Checking ${facilityName} (${facilityId})...`);

    // Determine which months we need to fetch
    const months = new Set<string>();
    for (const w of facilityWatches) {
      for (const d of w.dates) {
        months.add(d.slice(0, 7)); // "2026-06"
      }
    }

    try {
      const current = await fetchFacilityAvailability(facilityId, months);
      const availCount = Object.values(current).filter((s) => s === "Available").length;
      console.log(`  ${Object.keys(current).length} dates fetched, ${availCount} available`);

      // Load previous state from KV
      const stateKey = `cabin-state:${facilityId}`;
      const previousRaw = await env.STATE.get(stateKey);
      const previous: SiteAvailability = previousRaw ? JSON.parse(previousRaw) : {};

      // Find openings for each watch
      const openings = findOpenings(facilityWatches, current, previous, notifiedSet);

      if (openings.length > 0) {
        console.log(`  ${openings.length} new opening(s) found`);

        // Group openings by email (one email per user)
        const byEmail = new Map<string, Opening[]>();
        for (const o of openings) {
          const existing = byEmail.get(o.watch.email) || [];
          existing.push(o);
          byEmail.set(o.watch.email, existing);
        }

        for (const [email, userOpenings] of byEmail) {
          const unsubToken = userOpenings[0].watch.unsubscribe_token;
          const sent = await sendEmail(env, email, userOpenings, unsubToken);
          if (sent) {
            // Record notifications to prevent re-alerting
            for (const o of userOpenings) {
              await recordNotification(env, o.watch.id, o.date);
            }
          }
        }

        totalOpenings += openings.length;
      } else {
        console.log(`  No new openings`);
      }

      // Save state to KV only if changed
      const newRaw = JSON.stringify(current);
      if (newRaw !== previousRaw) {
        await env.STATE.put(stateKey, newRaw);
        console.log(`  State updated in KV`);
      }
    } catch (e) {
      console.error(`Error checking ${facilityName}:`, e);
    }
  }

  const summary = `Checked ${byFacility.size} cabin(s), ${totalOpenings} opening(s) found`;
  console.log(summary);
  return summary;
}

// ── Unsubscribe handler ──────────────────────────────────────────────────────

async function handleUnsubscribe(env: Env, token: string): Promise<Response> {
  const resp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/watches?unsubscribe_token=eq.${token}`,
    {
      method: "PATCH",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ active: false }),
    }
  );

  if (!resp.ok) {
    return new Response("Something went wrong. Please try again.", { status: 500 });
  }

  return new Response(
    `<html><body style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 60px auto; text-align: center;">
      <h2>Unsubscribed</h2>
      <p>You won't receive alerts for this watch anymore.</p>
    </body></html>`,
    { headers: { "Content-Type": "text/html" } }
  );
}

// ── Worker entry point ───────────────────────────────────────────────────────

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`Cron triggered at ${new Date(event.scheduledTime).toISOString()}`);
    ctx.waitUntil(checkCabins(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      ctx.waitUntil(checkCabins(env));
      return new Response("Check started — see worker logs (wrangler tail)\n", { status: 202 });
    }

    if (url.pathname === "/unsubscribe") {
      const token = url.searchParams.get("token");
      if (!token) return new Response("Missing token", { status: 400 });
      return handleUnsubscribe(env, token);
    }

    if (url.pathname === "/status") {
      const watches = await fetchActiveWatches(env);
      const summary = {
        activeWatches: watches.length,
        facilities: [...new Set(watches.map((w) => w.facility_name))],
      };
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      "recgov.me — Cabin Cancellation Monitor\n\nGET /check  — trigger manual check\nGET /status — view active watches\n",
      { status: 200 }
    );
  },
};
