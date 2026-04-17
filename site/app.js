// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://wfvouoennwwgcwnicrlq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_5MyzhOvqVGtbQohw3hHoag_zaIerGUb";

const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABELS = { mon: "M", tue: "T", wed: "W", thu: "Th", fri: "F", sat: "Sa", sun: "Su" };

let currentEmail = localStorage.getItem("recgovme_email") || "";
let cabins = [];
let selectedCabin = null;

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function sbFetch(path, opts = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!resp.ok && opts.method !== "DELETE") {
    throw new Error(`${resp.status}`);
  }
  if (resp.status === 204 || opts.headers?.Prefer === "return=minimal") return null;
  return resp.json();
}

// ── Toast ────────────────────────────────────────────────────────────────────

function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = isError ? "toast error" : "toast";
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 3000);
}

// ── Login / email ────────────────────────────────────────────────────────────

const loginSection = document.getElementById("login-section");
const dashboard = document.getElementById("dashboard");
const loginEmail = document.getElementById("login-email");
const loginBtn = document.getElementById("login-btn");
const userEmailSpan = document.getElementById("user-email");
const logoutBtn = document.getElementById("logout-btn");

function showDashboard(email) {
  currentEmail = email;
  localStorage.setItem("recgovme_email", email);
  userEmailSpan.textContent = email;
  loginSection.hidden = true;
  dashboard.hidden = false;
  loadWatches();
}

function showLogin() {
  currentEmail = "";
  localStorage.removeItem("recgovme_email");
  loginSection.hidden = false;
  dashboard.hidden = true;
}

loginBtn.addEventListener("click", () => {
  const email = loginEmail.value.trim();
  if (!email) return;
  showDashboard(email);
});

loginEmail.addEventListener("keydown", (e) => {
  if (e.key === "Enter") loginBtn.click();
});

logoutBtn.addEventListener("click", showLogin);

// Auto-login if email saved
if (currentEmail) {
  loginEmail.value = currentEmail;
  showDashboard(currentEmail);
}

// ── Load & render watches ────────────────────────────────────────────────────

async function loadWatches() {
  const list = document.getElementById("watches-list");
  try {
    const watches = await sbFetch(
      `watches?email=eq.${encodeURIComponent(currentEmail)}&order=created_at.desc`
    );
    renderWatches(watches);
  } catch (e) {
    list.innerHTML = `<p class="empty-state">Failed to load watches.</p>`;
  }
}

function renderWatches(watches) {
  const list = document.getElementById("watches-list");

  if (!watches || watches.length === 0) {
    list.innerHTML = `<p class="empty-state">No watches yet. Add one below.</p>`;
    return;
  }

  list.innerHTML = watches
    .map((w) => {
      const dates = w.dates || [];
      const first = dates[0] || "?";
      const last = dates[dates.length - 1] || "?";
      const days = w.days_of_week || [];
      const allDays = days.length === 0 || days.length === 7;

      const dayDots = ALL_DAYS.map(
        (d) =>
          `<span class="day-dot ${allDays || days.includes(d) ? "on" : ""}">${DAY_LABELS[d]}</span>`
      ).join("");

      return `
        <div class="watch-card ${w.active ? "" : "inactive"}" data-id="${w.id}">
          <div class="watch-actions">
            <button class="toggle-btn" onclick="toggleWatch('${w.id}', ${!w.active})">
              ${w.active ? "Pause" : "Resume"}
            </button>
            <button class="delete-btn" onclick="deleteWatch('${w.id}')">Delete</button>
          </div>
          <div class="cabin-name">${w.facility_name}</div>
          <div class="watch-details">
            ${formatDate(first)} — ${formatDate(last)} (${dates.length} dates)
          </div>
          <div class="watch-days">${dayDots}</div>
        </div>
      `;
    })
    .join("");
}

function formatDate(dateStr) {
  if (!dateStr || dateStr === "?") return "?";
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ── Watch actions ────────────────────────────────────────────────────────────

window.toggleWatch = async function (id, active) {
  try {
    await sbFetch(`watches?id=eq.${id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ active }),
    });
    loadWatches();
  } catch (e) {
    toast("Failed to update watch", true);
  }
};

window.deleteWatch = async function (id) {
  if (!confirm("Delete this watch?")) return;
  try {
    await sbFetch(`watches?id=eq.${id}`, { method: "DELETE" });
    loadWatches();
    toast("Watch deleted");
  } catch (e) {
    toast("Failed to delete watch", true);
  }
};

// ── Cabin search + URL paste ─────────────────────────────────────────────────

async function loadCabins() {
  try {
    const resp = await fetch("cabins.json");
    cabins = await resp.json();
  } catch (e) {
    cabins = [];
  }
}

const searchInput = document.getElementById("cabin-search");
const resultsList = document.getElementById("cabin-results");
const cabinIdInput = document.getElementById("cabin-id");
const cabinNameInput = document.getElementById("cabin-name");

searchInput.addEventListener("input", () => {
  const raw = searchInput.value.trim();
  selectedCabin = null;
  cabinIdInput.value = "";
  cabinNameInput.value = "";

  // Check if it's a Recreation.gov URL
  const urlMatch = raw.match(/recreation\.gov\/camping\/campgrounds\/(\d+)/);
  if (urlMatch) {
    const facilityId = urlMatch[1];
    selectedCabin = { id: facilityId, name: "" };
    cabinIdInput.value = facilityId;
    resultsList.hidden = true;
    // Try to fetch the name from the API
    fetchFacilityName(facilityId);
    return;
  }

  const q = raw.toLowerCase();
  if (q.length < 2) {
    resultsList.hidden = true;
    return;
  }

  const matches = cabins
    .filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.parent && c.parent.toLowerCase().includes(q))
    )
    .slice(0, 20);

  if (matches.length === 0) {
    resultsList.hidden = true;
    return;
  }

  resultsList.innerHTML = matches
    .map(
      (c) =>
        `<li data-id="${c.id}" data-name="${c.name}">
          ${c.name}
          ${c.parent ? `<span class="parent">${c.parent}</span>` : ""}
        </li>`
    )
    .join("");
  resultsList.hidden = false;
});

async function fetchFacilityName(facilityId) {
  try {
    const resp = await fetch(
      `https://www.recreation.gov/api/camps/campgrounds/${facilityId}`,
      { headers: { Accept: "application/json" } }
    );
    if (resp.ok) {
      const data = await resp.json();
      const name = data?.campground?.facility_name || data?.campground?.campground_name || `Facility ${facilityId}`;
      selectedCabin = { id: facilityId, name };
      cabinNameInput.value = name;
      searchInput.value = name;
      toast(`Found: ${name}`);
    }
  } catch (e) {
    // If CORS blocks it, just use the ID
    selectedCabin = { id: facilityId, name: `Cabin ${facilityId}` };
    cabinNameInput.value = selectedCabin.name;
  }
}

resultsList.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  selectedCabin = { id: li.dataset.id, name: li.dataset.name };
  searchInput.value = selectedCabin.name;
  cabinIdInput.value = selectedCabin.id;
  cabinNameInput.value = selectedCabin.name;
  resultsList.hidden = true;
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".cabin-picker")) {
    resultsList.hidden = true;
  }
});

// ── Day of week picker ───────────────────────────────────────────────────────

document.querySelectorAll(".dow-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    btn.classList.toggle("active");
  });
});

function getSelectedDays() {
  const days = [];
  document.querySelectorAll(".dow-btn.active").forEach((btn) => {
    days.push(btn.dataset.day);
  });
  // If all selected, return empty array (means "any day")
  return days.length === 7 ? [] : days;
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function generateDates(startStr, endStr) {
  const dates = [];
  const current = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  while (current <= end) {
    const yyyy = current.getFullYear();
    const mm = String(current.getMonth() + 1).padStart(2, "0");
    const dd = String(current.getDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// ── Form submission ──────────────────────────────────────────────────────────

const form = document.getElementById("watch-form");
const submitBtn = document.getElementById("submit-btn");

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!selectedCabin) {
    toast("Select a cabin or paste a Recreation.gov URL", true);
    return;
  }

  const dateStart = document.getElementById("date-start").value;
  const dateEnd = document.getElementById("date-end").value;

  if (!dateStart || !dateEnd) {
    toast("Select start and end dates", true);
    return;
  }
  if (dateStart > dateEnd) {
    toast("End date must be after start date", true);
    return;
  }

  const dates = generateDates(dateStart, dateEnd);
  if (dates.length > 365) {
    toast("Date range too large (max 1 year)", true);
    return;
  }

  const daysOfWeek = getSelectedDays();
  if (daysOfWeek.length === 0 && document.querySelectorAll(".dow-btn.active").length === 0) {
    toast("Select at least one day of the week", true);
    return;
  }

  const facilityName = cabinNameInput.value || selectedCabin.name || `Cabin ${selectedCabin.id}`;

  submitBtn.disabled = true;
  submitBtn.textContent = "Adding...";

  try {
    await sbFetch("watches", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        email: currentEmail,
        facility_id: selectedCabin.id,
        facility_name: facilityName,
        dates,
        days_of_week: daysOfWeek,
      }),
    });

    toast("Watch added!");
    form.reset();
    selectedCabin = null;
    // Re-select all days
    document.querySelectorAll(".dow-btn").forEach((btn) => btn.classList.add("active"));
    loadWatches();
  } catch (err) {
    toast(`Failed to add watch: ${err.message}`, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Add watch";
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
document.getElementById("date-start").min = today;
document.getElementById("date-end").min = today;

loadCabins();
