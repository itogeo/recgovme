// ── Config — replace with your Supabase project ─────────────────────────────

const SUPABASE_URL = "https://wfvouoennwwgcwnicrlq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_5MyzhOvqVGtbQohw3hHoag_zaIerGUb";

// ── Cabin search ─────────────────────────────────────────────────────────────

let cabins = [];
let selectedCabin = null;

async function loadCabins() {
  try {
    const resp = await fetch("cabins.json");
    cabins = await resp.json();
  } catch (e) {
    console.error("Failed to load cabins.json:", e);
  }
}

const searchInput = document.getElementById("cabin-search");
const resultsList = document.getElementById("cabin-results");
const cabinIdInput = document.getElementById("cabin-id");
const cabinNameInput = document.getElementById("cabin-name");

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toLowerCase();
  selectedCabin = null;
  cabinIdInput.value = "";
  cabinNameInput.value = "";

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

resultsList.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;

  selectedCabin = {
    id: li.dataset.id,
    name: li.dataset.name,
  };
  searchInput.value = selectedCabin.name;
  cabinIdInput.value = selectedCabin.id;
  cabinNameInput.value = selectedCabin.name;
  resultsList.hidden = true;
});

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".cabin-picker")) {
    resultsList.hidden = true;
  }
});

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
const successDiv = document.getElementById("success");
const errorDiv = document.getElementById("error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  successDiv.hidden = true;
  errorDiv.hidden = true;

  if (!selectedCabin) {
    errorDiv.textContent = "Please select a cabin from the dropdown.";
    errorDiv.hidden = false;
    return;
  }

  const dateStart = document.getElementById("date-start").value;
  const dateEnd = document.getElementById("date-end").value;
  const email = document.getElementById("email").value.trim();
  const weekendsOnly = document.getElementById("weekends-only").checked;

  if (!dateStart || !dateEnd) {
    errorDiv.textContent = "Please select start and end dates.";
    errorDiv.hidden = false;
    return;
  }

  if (dateStart > dateEnd) {
    errorDiv.textContent = "End date must be after start date.";
    errorDiv.hidden = false;
    return;
  }

  const dates = generateDates(dateStart, dateEnd);
  if (dates.length > 180) {
    errorDiv.textContent = "Date range too large. Please select 6 months or less.";
    errorDiv.hidden = false;
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Saving...";

  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/watches`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        email,
        facility_id: selectedCabin.id,
        facility_name: selectedCabin.name,
        dates,
        weekends_only: weekendsOnly,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Server error: ${resp.status}`);
    }

    successDiv.hidden = false;
    form.reset();
    selectedCabin = null;
  } catch (err) {
    errorDiv.textContent = `Something went wrong: ${err.message}`;
    errorDiv.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Watch this cabin";
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

// Set min date to today
const today = new Date().toISOString().slice(0, 10);
document.getElementById("date-start").min = today;
document.getElementById("date-end").min = today;

loadCabins();
