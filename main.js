// Main logic for user metadata deep research dashboard

// Helper: Sleep util
const sleep = ms => new Promise(res => setTimeout(res, ms));

const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const analyzeBtn = document.getElementById('analyze-llm');
const decisionSection = document.getElementById('decisionSection');
const decideBtn = document.getElementById('decide-llm');
const llmSection = document.getElementById('llmAnalysisSection');
const llmDecisionFeedback = document.getElementById('llmDecisionFeedback');

// Store user metadata/records here after processing
let allRecordResults = [];
let llmGlobalAnalysis = "";
let selectedRecordIndices = [];

// Helper: Save and load progress from localStorage
const LS_KEY = "__user_research_meta__results";
function saveToStorage(records) {
  localStorage.setItem(LS_KEY, JSON.stringify(records));
}
function loadFromStorage() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
  catch { return []; }
}

// Main async chain
(async function main() {
  statusEl.innerHTML = `<span class="spinner"></span> Fetching user details...`;

  // Find the "current" user
  let user = null;
  try {
    user = (await window.websim.getUser())?.user || 
           (await window.websim.getUser()) || null;
  } catch (e) { }
  if (!user || !user.username) {
    statusEl.textContent = "Could not determine current user.";
    return;
  }
  statusEl.innerHTML = `User: <img src="https://images.websim.ai/avatar/${user.username}" style="border-radius:100%;width:2em;vertical-align:middle" /> <b>@${user.username}</b> — Fetching all public metadata...`;

  // Aggregate everything we can: likes, projects, sites, following, followers, stats...
  let [
    likesResp, projectsResp, sitesResp, followersResp, followingResp, statsResp
  ] = await Promise.allSettled([
    fetch(`/api/v1/users/${user.username}/likes?first=1000&last=0`).then(r => r.json()),
    fetch(`/api/v1/users/${user.username}/projects?first=1000&last=0`).then(r => r.json()),
    fetch(`/api/v1/users/${user.username}/sites?first=1000&last=0`).then(r => r.json()),
    fetch(`/api/v1/users/${user.username}/followers?first=1000&last=0`).then(r => r.json()),
    fetch(`/api/v1/users/${user.username}/following?first=1000&last=0`).then(r => r.json()),
    fetch(`/api/v1/users/${user.username}/stats`).then(r => r.json()).catch(()=>({})),
  ]);
  // Pull results
  let likes = likesResp.value?.likes?.data ?? [];
  let projects = projectsResp.value?.projects?.data ?? [];
  let sites = sitesResp.value?.sites?.data ?? [];
  let followers = followersResp.value?.followers?.data ?? [];
  let following = followingResp.value?.following?.data ?? [];
  let stats = statsResp?.value?.stats ?? {};

  let stackOfRecords = [];

  // Collect all data, annotate with source and necessary details for score/LLM
  for (const lk of likes) stackOfRecords.push({ type: "liked_site", ...lk });
  for (const pj of projects) stackOfRecords.push({ type: "own_project", ...pj });
  for (const si of sites) stackOfRecords.push({ type: "own_site", ...si });
  for (const f of followers) stackOfRecords.push({ type: "follower", ...f });
  for (const f of following) stackOfRecords.push({ type: "following", ...f });

  // batch analyze with LLM, 5-8 at a time for scoring/insights, then overall
  statusEl.innerHTML = `<span class="spinner"></span> Analyzing ${stackOfRecords.length} records for research insights via AI...`;

  // For each stack chunk, use the LLM to get a "score" and info
  let batchSize = 8;
  let processedRecords = [];
  for (let i = 0; i < stackOfRecords.length; i += batchSize) {
    let chunk = stackOfRecords.slice(i, i + batchSize);

    // Shorten for LLM prompt
    const dataForBatch = chunk.map((rec, idx) => {
      let t = rec.type;
      if (t === "liked_site") return `Like: "${rec.site?.site?.title||rec.site?.title||'Unknown'}"`;
      if (t === "own_project") return `Project: "${rec.project?.title||'Untitled'}" (${rec.project?.stats?.views||0} views, ${rec.project?.stats?.likes||0} likes)`;
      if (t === "own_site") return `Site: "${rec.site?.title||'Untitled'}"`;
      if (t === "follower") return `Follower: @${rec.follow?.user?.username||"?"}`;
      if (t === "following") return `Following: @${rec.follow?.user?.username||"?"}`;
      return `Other: ${JSON.stringify(rec).slice(0,80)}`;
    });

    // Use LLM to judge/describe/score this batch (system prompt: be analytical, help for self-improvement, assign an "interest" score)
    const llmRes = await window.websim.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are an expert researcher. For each item below, score its 'interest for working on' (1-10, higher=better to work on now), provide a concise reason, and a one-line suggestion. Format as JSON: [{score, title, reason, suggestion}].",
        },
        {
          role: "user",
          content: dataForBatch.join('\n')
        }
      ],
      json: true
    });
    let resultsForChunk;
    try {
      resultsForChunk = JSON.parse(llmRes.content);
      if (!Array.isArray(resultsForChunk)) throw new Error("LLM returned invalid JSON");
    } catch (e) {
      // fallback: assign neutral results
      resultsForChunk = chunk.map(r => ({score:5,title:"Unknown",reason:"No AI response",suggestion:"Try again"}));
    }
    // Attach LLM analysis to records
    for (let j = 0; j < chunk.length; ++j) {
      chunk[j].llm = resultsForChunk[j] || null;
      processedRecords.push(chunk[j]);
    }
    // Async pause to yield
    await sleep(80);
  }

  // Save to storage & global variable
  allRecordResults = processedRecords;
  saveToStorage(allRecordResults);

  // After all processed
  statusEl.innerHTML = `Done — Analyzed <b>${allRecordResults.length}</b> records.`;

  // Show all results as a list
  renderResults();

  // Enable LLM analysis
  analyzeBtn.disabled = false;
  analyzeBtn.onclick = runGlobalLLMInsights;

  // Enable selection for record-wise decisions
  resultsEl.onclick = e => {
    let target = e.target.closest('.record');
    if (!target) return;
    let idx = +target.dataset.idx;
    if (isNaN(idx)) return;
    // Toggle select
    let selIdx = selectedRecordIndices.indexOf(idx);
    if (selIdx >= 0) {
      selectedRecordIndices.splice(selIdx, 1);
      target.classList.remove('selected');
    } else {
      selectedRecordIndices.push(idx);
      target.classList.add('selected');
    }
    // Show or hide decision section depending on selection
    decisionSection.style.display = selectedRecordIndices.length > 0 ? "" : "none";
  };

  decideBtn.onclick = runDecisionLLM;
})();

// Render all processed results
function renderResults() {
  let html = '';
  selectedRecordIndices = [];
  for (let i = 0; i < allRecordResults.length; ++i) {
    let rec = allRecordResults[i];
    let title = "";
    // Format per type
    if (rec.type === "own_project") {
      title = `<b>Project:</b> ${rec.project?.title || "Untitled project"}`;
    } else if (rec.type === "own_site") {
      title = `<b>Site:</b> ${rec.site?.title || "Untitled site"}`;
    } else if (rec.type === "liked_site") {
      title = `<b>Liked:</b> ${rec.site?.site?.title || rec.site?.title || "Site"}`;
    } else if (rec.type === "follower") {
      title = `<b>Follower:</b> @${rec.follow?.user?.username}`;
    } else if (rec.type === "following") {
      title = `<b>Following:</b> @${rec.follow?.user?.username}`;
    } else {
      title = `<b>[?]</b> ${JSON.stringify(rec).slice(0,80)}`;
    }
    let score = rec.llm?.score || "-";
    let reason = rec.llm?.reason || "";
    let suggestion = rec.llm?.suggestion || "";
    html += `<div class="record" data-idx="${i}">
      <span class="score">Score: ${score}</span>
      ${title}<br>
      <small title="${reason}">${reason}</small>
      <br><em>${suggestion ? "💡 "+suggestion : ""}</em>
    </div>`;
  }
  resultsEl.innerHTML = html;
}

// LLM: Analyze the stack as a whole for patterns and suggestions
async function runGlobalLLMInsights() {
  analyzeBtn.disabled = true;
  llmSection.style.display = "";
  llmSection.innerHTML = `<span class="spinner"></span> LLM is analyzing your full activity metadata for patterns, strengths, and ideas...`;
  let shortSummaries = allRecordResults.map(r =>
    (r.llm?.title || "Unknown title") + " (Score "+(r.llm?.score||"-")+")"
  ).slice(0, 80);

  // If too many items summarize only top 80
  const llmRes = await window.websim.chat.completions.create({
    messages: [
      {
        role: "system",
        content: "You're a life+career strategy AI. Given a user's top 80 recent activities (records, sites, projects...), analyze the overall strengths, missing areas, and suggest up to 5 areas for effective work/focus next week. Use approachable, motivating language.",
      },
      {
        role: "user",
        content: shortSummaries.join("\n"),
      },
    ]
  });
  llmGlobalAnalysis = llmRes.content;
  llmSection.innerHTML = `<h2>LLM Meta-Insights:</h2><div style="white-space: pre-line">${llmRes.content}</div>`;
}

// LLM: Help user decide what to work on based on selected records
async function runDecisionLLM() {
  decideBtn.disabled = true;
  llmDecisionFeedback.innerHTML = `<span class="spinner"></span> LLM pondering best options...`;
  let picks = selectedRecordIndices.map(idx => {
    let r = allRecordResults[idx];
    return {
      title: r.llm?.title || "?",
      reason: r.llm?.reason || "",
      suggestion: r.llm?.suggestion || ""
    };
  });
  const prompt = picks.map(p => 
    `[${p.title}] Reason: ${p.reason}. Suggestion: ${p.suggestion}`
  ).join("\n");

  // LLM prompt to help choose what to work on
  const res = await window.websim.chat.completions.create({
    messages: [
      {
        role: "system",
        content: "Act as a user's creativity and productivity coach. Given the set of ideas/records below (each with a reason and a suggestion), choose the most promising one, explain why, and offer concrete next steps for the user to make progress.",
      },
      { role: "user", content: prompt }
    ]
  });
  llmDecisionFeedback.innerHTML = `<strong>LLM says:</strong><br><div style="white-space: pre-line">${res.content}</div>`;
  decideBtn.disabled = false;
}

