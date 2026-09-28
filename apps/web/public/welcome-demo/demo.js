/**
 * Standalone welcome-demo controller.
 *
 * Side-effect-free by construction: every action is simulated in this page.
 * No settings are read or written, no network requests are made, and nothing
 * is persisted (the URL hash only carries deep-link state for screenshots).
 * Deep links: #step=1..7&stop=0..4&run=1
 */
;(() => {
  'use strict'

  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => Array.from(document.querySelectorAll(sel))

  const STEP_META = {
    1: { label: 'Welcome' },
    2: { label: 'Security & access' },
    3: { label: 'First provider' },
    4: { label: 'Intelligence' },
    5: { label: 'The tour' },
    6: { label: 'Agents' },
    7: { label: 'Done' },
  }

  const STEPS = [1, 2, 3, 4, 5, 6, 7]

  // Tour stops over the placeholder chrome. `place` is where the tip sits
  // relative to the spotlighted region.
  const TOUR = [
    {
      target: '.app-sidebar',
      place: 'right',
      pad: 8,
      title: 'Sessions',
      body: 'Start here. New session at the top; every past session stays as a row below it.',
    },
    {
      target: '[data-spot="settings"]',
      place: 'right',
      pad: 8,
      title: 'Settings',
      body: 'Models, Orchestration, Permissions, Dynamic — the switches all live behind this row.',
    },
    {
      target: '[data-spot="plugins"]',
      place: 'right',
      pad: 8,
      title: 'Plugins, skills & MCP',
      body: 'Skills and MCP servers are added here and under Settings → Dynamic.',
    },
    {
      target: '[data-spot="composer"]',
      place: 'top',
      pad: 8,
      title: 'The composer switches',
      body: 'Agent preset, access mode, model picker and plan — the four controls you will touch most.',
    },
    {
      target: '[data-spot="context"]',
      place: 'right',
      pad: 8,
      title: 'Context Dashboard',
      body: "How much of the model's window your sessions are using. Open it any time from here.",
    },
  ]

  // Step 3 catalogue mirror: the template fields the real AddProviderModal
  // fills from provider-presets.ts and the heavy manifests. Demo values only;
  // nothing is written anywhere.
  const PROVIDERS = {
    opencode: { name: 'OpenCode Zen', env: 'OPENCODE_API_KEY', protocol: 'openai-completions', baseURL: 'https://opencode.ai/zen/v1', doc: 'https://opencode.ai/docs/zen' },
    'opencode-go': { name: 'OpenCode Go', env: 'OPENCODE_API_KEY', protocol: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1', doc: 'https://opencode.ai/docs/zen' },
    anthropic: { name: 'Anthropic', env: 'ANTHROPIC_API_KEY', protocol: 'anthropic-messages', baseURL: 'https://api.anthropic.com', doc: 'https://docs.anthropic.com/en/docs/about-claude/models' },
    'github-copilot': { name: 'GitHub Copilot', env: 'GITHUB_TOKEN', protocol: 'openai-completions', baseURL: 'https://api.githubcopilot.com', doc: 'https://docs.github.com/en/copilot' },
    openai: { name: 'OpenAI', env: 'OPENAI_API_KEY', protocol: 'openai-responses', baseURL: 'https://api.openai.com/v1', doc: 'https://platform.openai.com/docs/models' },
    google: { name: 'Google', env: 'GOOGLE_API_KEY', protocol: 'openai-completions', baseURL: 'https://generativelanguage.googleapis.com/v1beta', doc: 'https://ai.google.dev/gemini-api/docs/models' },
    openrouter: { name: 'OpenRouter', env: 'OPENROUTER_API_KEY', protocol: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', doc: 'https://openrouter.ai/models' },
    vercel: { name: 'Vercel AI Gateway', env: 'AI_GATEWAY_API_KEY', protocol: 'openai-completions', baseURL: '', doc: 'https://github.com/vercel/ai/tree/5eb85cc45a259553501f535b8ac79a77d0e79223/packages/gateway' },
    deepseek: { name: 'DeepSeek', env: 'DEEPSEEK_API_KEY', protocol: 'openai-completions', baseURL: 'https://api.deepseek.com', doc: 'https://api-docs.deepseek.com/quick_start/pricing' },
    kilo: { name: 'Kilo Gateway', env: 'KILO_API_KEY', protocol: 'openai-completions', baseURL: 'https://api.kilo.ai/api/gateway', doc: 'https://kilo.ai', keyless: true, models: 5, model: 'kilo-auto/free' },
  }

  // FreeLLMAPI's platform variants (HeavyProviderDocs' install table, verbatim).
  const FREELLMAPI_PLATFORMS = {
    linux: {
      label: 'Install locally (vendor one-liner, Docker)',
      deps: 'Docker Engine + Compose',
      disk: '~700 MB disk (536 MB image), ~84 MB RAM idle, no GPU',
      steps: [
        { label: 'Run the FreeLLMAPI one-liner', command: 'curl -fsSL https://freellmapi.co/install.sh | PORT=3002 HOST_BIND=127.0.0.1 bash' },
        { label: 'Wait for the gateway', command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1' },
      ],
    },
    darwin: {
      label: 'Install locally (vendor desktop app, no Docker)',
      deps: 'macOS 11+',
      disk: '~250 MB app; data in ~/Library/Application Support/FreeLLMAPI',
      steps: [
        { label: 'Download the latest .dmg', command: 'mkdir -p {home}/Downloads && curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE \'"browser_download_url": *"[^"]+\\.dmg"\' | head -1 | cut -d\'"\' -f4 | xargs -I{} curl -fsSL -o {home}/Downloads/FreeLLMAPI.dmg {}' },
        { label: 'Install the app from the disk image', command: 'hdiutil attach {home}/Downloads/FreeLLMAPI.dmg -nobrowse -quiet -mountpoint /tmp/freellmapi-dmg && cp -R /tmp/freellmapi-dmg/*.app /Applications/ && hdiutil detach /tmp/freellmapi-dmg -quiet' },
        { label: 'Pin the desktop app to port 3002', command: 'mkdir -p {home}/Library/Application\\ Support/FreeLLMAPI && printf \'{"port":3002}\\n\' > {home}/Library/Application\\ Support/FreeLLMAPI/config.json' },
        { label: 'Launch FreeLLMAPI', command: 'open -a FreeLLMAPI' },
        { label: 'Wait for the gateway', command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1' },
      ],
    },
    win32: {
      label: 'Install locally (vendor desktop app, no Docker)',
      deps: 'Windows 10+',
      disk: '~250 MB app; data in %APPDATA%\\FreeLLMAPI',
      steps: [
        { label: 'Download the latest installer', command: 'mkdir -p {home}/Downloads && curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE \'"browser_download_url": *"[^"]+\\.exe"\' | head -1 | cut -d\'"\' -f4 | xargs -I{} curl -fsSL -o {home}/Downloads/FreeLLMAPI-Setup.exe {}' },
        { label: 'Install silently', command: 'cmd //c start //wait "" "$HOME/Downloads/FreeLLMAPI-Setup.exe" /S' },
        { label: 'Pin the desktop app to port 3002', command: 'mkdir -p "$APPDATA/FreeLLMAPI" && printf \'{"port":3002}\\n\' > "$APPDATA/FreeLLMAPI/config.json"' },
        { label: 'Launch FreeLLMAPI', command: 'cmd //c start "" "$LOCALAPPDATA\\Programs\\FreeLLMAPI\\FreeLLMAPI.exe"' },
        { label: 'Wait for the gateway', command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1' },
      ],
    },
  }

  const state = {
    step: 1,
    stop: 0,
    inTour: false,
    analysis: 'idle', // idle | running | done
    sandbox: 'workspace-write',
    toggles: { compaction: true, keeper: true, whiteboard: true },
    compactionMode: 'llm',
    provider: 'kilo',
    providerView: 'picker',
    providerCreated: false,
    providerRunning: false,
    visited4: false,
    choices: {}, // step -> 'done' | 'skipped'
    finished: false,
  }

  const timers = []
  const later = (fn, ms) => {
    const id = setTimeout(fn, ms)
    timers.push(id)
    return id
  }
  const clearTimers = () => {
    while (timers.length) clearTimeout(timers.pop())
  }

  const body = document.body
  const wizard = $('#wizard')
  const panelScroll = $('#panelScroll')
  const stepCount = $('#stepCount')
  const footDots = $('#footDots')
  const spot = $('#spot')
  const spotHole = $('#spotHole')
  const spotTip = $('#spotTip')
  const tipCount = $('#tipCount')
  const tipTitle = $('#tipTitle')
  const tipBody = $('#tipBody')
  const dock = $('#dock')
  const dockLines = $('#dockLines')
  const dockTitle = $('#dockTitle')
  const dockFoot = $('#dockFoot')
  const dockTag = $('#dockTag')
  const toastEl = $('#toast')
  const helpMask = $('#helpMask')
  const doneToast = $('#doneToast')
  const offerStatus = $('#offerStatus')
  const offerActions = $('#offerActions')

  let toastTimer = null

  function toast(text) {
    toastEl.textContent = text
    toastEl.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastEl.hidden = true }, 2600)
  }

  // ── Wizard rendering ──────────────────────────────────────────────────────

  function render() {
    const step = state.step
    if (!state.inTour && step === 4) state.visited4 = true
    $$('.step').forEach((el) => { el.hidden = Number(el.dataset.step) !== step })
    $$('#stepList li').forEach((li) => {
      const n = Number(li.dataset.jump)
      const choice = state.choices[n]
      const isActive = !state.inTour && n === step
      li.dataset.state = isActive ? 'active' : choice === 'skipped' ? 'skipped' : choice === 'done' ? 'done' : ''
      const btn = li.querySelector('button')
      btn.setAttribute('aria-current', isActive ? 'step' : 'false')
    })

    footDots.innerHTML = STEPS.map((n) => {
      const cls = n === step ? 'on' : state.choices[n] === 'skipped' ? 'skipped' : ''
      return `<i class="${cls}"></i>`
    }).join('')

    stepCount.textContent = `Step ${step} of 7`
    if (state.inTour) stepCount.textContent = `Step 5 of 7 · tour stop ${state.stop + 1}/${TOUR.length}`
    renderDone()
  }

  function renderDone() {
    const skipped = STEPS.filter((n) => state.choices[n] === 'skipped')
    const card = $('#skippedCard')
    const list = $('#skippedList')
    if (!skipped.length) {
      card.hidden = true
      $('#doneLead').textContent = 'Nothing here was required — and nothing was skipped. The harness is ready as configured.'
      return
    }
    card.hidden = false
    $('#skippedTitle').textContent = `You skipped ${skipped.length} step${skipped.length > 1 ? 's' : ''} — defaults apply`
    const consequences = {
      1: 'The tour never ran; nothing changes.',
      2: 'Sandbox stays at workspace-write.',
      3: 'Kilo Gateway stays the default route (keyless, free).',
      4: 'Compaction, Keeper and Whiteboard stay on — the install default — and can be switched off later in Settings → Orchestration.',
      5: 'The interface tour was skipped; reopen it from this demo or the Help surface later.',
      6: "Agents start from a default system context; ask Sysadmin to analyse the machine later.",
      7: 'Nothing to skip at the end.',
    }
    list.innerHTML = skipped.map((n) => `<li><strong>Step ${n} · ${STEP_META[n].label}:</strong> ${consequences[n]}</li>`).join('')
    $('#doneLead').textContent = 'Skipped steps keep their defaults. The harness works either way — nothing below is required.'
  }

  function markCurrent(choice) {
    if (state.step >= 1 && state.step <= 7) {
      const prev = state.choices[state.step]
      // Never downgrade a completed step to skipped.
      if (!(prev === 'done' && choice === 'skipped')) state.choices[state.step] = choice
    }
  }

  function gotoStep(n, opts = {}) {
    const target = Math.min(7, Math.max(1, n))
    if (state.inTour) exitTour('skipped', true)
    const forward = target > state.step
    if (forward) {
      // Steps passed over without acting keep their defaults; steps with a real
      // action count as done when that action happened, otherwise as skipped.
      for (let n = state.step; n < target; n += 1) {
        if (state.choices[n]) continue
        if (n === 1 || n === 7) state.choices[n] = 'done'
        else if (n === 3 && state.providerCreated) state.choices[n] = 'done'
        else if (n === 4 && state.visited4) state.choices[n] = 'done'
        else if (n === 6 && state.analysis !== 'idle') state.choices[n] = 'done'
        else state.choices[n] = 'skipped'
      }
    }
    state.step = target
    render()
    if (!opts.keepHash) syncHash()
    if (!opts.instant) {
      panelScroll.scrollTop = 0
      const heading = document.querySelector(`.step[data-step="${target}"] h1`)
      if (heading) heading.focus({ preventScroll: true })
    }
  }

  function next() {
    if (state.inTour) { tourNext(); return }
    if (state.step === 7) { finish(); return }
    gotoStep(state.step + 1)
  }

  function prev() {
    if (state.inTour) { tourPrev(); return }
    gotoStep(state.step - 1)
  }

  function skipStep() {
    if (state.inTour) { exitTour('skipped'); return }
    markCurrent('skipped')
    if (state.step === 7) finish()
    else gotoStep(state.step + 1)
  }

  function skipAll() {
    if (state.inTour) exitTour('skipped', true)
    gotoStep(7, { keepHash: true })
    syncHash()
  }

  function finish() {
    markCurrent('done')
    state.finished = true
    body.dataset.mode = 'done'
    doneToast.hidden = false
    syncHash()
  }

  function reset() {
    clearTimers()
    state.step = 1
    state.stop = 0
    state.inTour = false
    state.analysis = 'idle'
    state.sandbox = 'workspace-write'
    state.toggles = { compaction: true, keeper: true, whiteboard: true }
    state.compactionMode = 'llm'
    state.visited4 = false
    state.choices = {}
    state.finished = false
    body.dataset.mode = ''
    doneToast.hidden = true
    helpMask.hidden = true
    spot.hidden = true
    dock.hidden = true
    dockLines.innerHTML = ''
    dockFoot.hidden = true
    dockTag.hidden = false
    offerStatus.hidden = true
    offerActions.hidden = false
    resetProvider()
    $$('.switch').forEach((sw) => setSwitch(sw, true))
    $$('.radio').forEach((r) => {
      const on = r.dataset.mode === 'workspace-write'
      r.setAttribute('aria-checked', String(on))
      if (on) state.sandbox = r.dataset.mode
    })
    setCompactionMode('llm')
    updateIntelButton()
    render()
    syncHash()
    toast('Demo reset — nothing was ever stored.')
  }

  // ── Step 3: the Add Provider mirror (catalogue → form → discovery) ────────

  function showProviderView(view) {
    state.providerView = view
    $$('#pModal .pview').forEach((el) => { el.hidden = el.dataset.pview !== view })
    $('#pFootPicker').hidden = view !== 'picker'
    $('#pFootForm').hidden = view !== 'form'
    $('#pFootHeavy').hidden = view !== 'heavy'
    $('#pFootDocs').hidden = view !== 'heavydocs'
    const heavyish = view === 'heavy' || view === 'heavydocs'
    $('#pModalTitle').textContent = view === 'picker'
      ? 'Add model provider'
      : `Add ${heavyish ? 'FreeLLMAPI' : (PROVIDERS[state.provider] || PROVIDERS.kilo).name}`
    $('#pFootNote').textContent = view === 'picker'
      ? 'Kilo Gateway is pre-selected for this first run.'
      : view === 'form'
        ? 'Keyless route — nothing here needs a key.'
        : view === 'heavy'
          ? 'Detected instance — nothing is installed until you choose Install locally.'
          : 'Platform install steps — the host platform is selected by default.'
    $('#pModalBody').scrollTop = 0
  }

  function resetProviderResult() {
    $('#pResult').hidden = true
    $('#pDiscovering').hidden = true
    $('#pDiscovered').hidden = true
    $('#pTestOk').hidden = true
    $('#pTestBubble').hidden = true
    const btn = $('#btnPCreate')
    btn.disabled = false
    btn.textContent = 'Create provider'
  }

  function selectProvider(id) {
    const p = PROVIDERS[id]
    if (!p) return
    state.provider = id
    $('#pDisplayName').value = p.name
    $('#pProviderId').value = id
    $('#pProtocol').value = p.protocol
    $('#pBaseUrl').value = p.baseURL
    $('#pApiKey').value = ''
    $('#pApiKey').placeholder = p.keyless
      ? 'No key required — leave empty for the anonymous free tier'
      : p.env ? `Env ref: ${p.env}` : 'Enter API Key (optional for local/proxy endpoints)'
    $('#pEnv').textContent = p.env || 'none'
    $('#pKeylessHint').hidden = !p.keyless
    $('#pDoc').hidden = !p.doc
    if (p.doc) $('#pDoc').href = p.doc
    resetProviderResult()
    showProviderView('form')
  }

  function finishProviderCreate(p) {
    state.providerCreated = true
    $('#pDiscovering').hidden = true
    $('#pResult').hidden = false
    $('#pDiscovered').innerHTML = p.models
      ? `✓ Models discovered: <strong>${p.models}</strong> — written to the route.`
      : '✓ Models discovered — written to the route.'
    $('#pDiscovered').hidden = false
    if (p.keyless) {
      $('#pTestOk').hidden = false
      $('#pTestBubble').hidden = false
    }
    const btn = $('#btnPCreate')
    btn.disabled = false
    btn.textContent = 'Create provider'
    markCurrent('done')
    render()
  }

  function createProvider() {
    const p = PROVIDERS[state.provider]
    if (!p || state.providerRunning || state.providerCreated) return
    state.providerRunning = true
    $('#pResult').hidden = false
    $('#pDiscovering').hidden = false
    $('#pDiscovered').hidden = true
    $('#pTestOk').hidden = true
    $('#pTestBubble').hidden = true
    const btn = $('#btnPCreate')
    btn.disabled = true
    btn.textContent = 'Discovering models…'
    later(() => {
      state.providerRunning = false
      finishProviderCreate(p)
      toast('Demo only — no route was created. Discovery and the test call are simulated.')
    }, 1150)
  }

  function setProviderPlatform(plat) {
    const data = FREELLMAPI_PLATFORMS[plat]
    if (!data) return
    $$('.ph-plat').forEach((b) => b.classList.toggle('on', b.dataset.plat === plat))
    $('#phLocalLabel').textContent = data.label
    $('#phLocalDeps').textContent = `Dependencies: ${data.deps}`
    $('#phLocalDisk').textContent = `Footprint: ${data.disk}`
    $('#phSteps').innerHTML = data.steps.map((s) =>
      `<li><strong>${s.label}</strong><pre>${s.command.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></li>`).join('')
    $('#phInstallList').innerHTML = data.steps.map((s) => `<li>${s.label}</li>`).join('')
  }

  function resetProvider() {
    state.provider = 'kilo'
    state.providerCreated = false
    state.providerRunning = false
    resetProviderResult()
    setProviderPlatform('linux')
    showProviderView('picker')
  }

  function applyProviderHash(h) {
    if (!h || h.step !== 3) return
    if (h.view === 'heavy') { showProviderView('heavy'); return }
    if (h.view === 'docs') { showProviderView('heavydocs'); return }
    if (h.run) {
      selectProvider('kilo')
      finishProviderCreate(PROVIDERS.kilo)
      return
    }
    if (h.provider && PROVIDERS[h.provider]) { selectProvider(h.provider); return }
    showProviderView('picker')
  }

  // ── Step 4: toggles ───────────────────────────────────────────────────────

  function setSwitch(sw, on) {
    sw.setAttribute('aria-checked', String(on))
    sw.querySelector('.sw-label').textContent = on ? 'On' : 'Off'
    const card = sw.closest('.toggle-card')
    card.dataset.on = String(on)
    card.querySelector('.toggle-detail').hidden = !on
    const feature = card.dataset.feature
    state.toggles[feature] = on
    if (feature === 'compaction') setCompactionMode(state.compactionMode)
    updateIntelButton()
  }

  function updateIntelButton() {
    const any = Object.values(state.toggles).some(Boolean)
    $('#btnIntelNext').innerHTML = any
      ? 'Continue <span class="arrow">→</span>'
      : 'Continue with them off <span class="arrow">→</span>'
  }

  function setCompactionMode(mode) {
    state.compactionMode = mode
    $$('.seg-btn').forEach((b) => {
      const on = b.dataset.comp === mode
      b.classList.toggle('on', on)
      b.setAttribute('aria-checked', String(on))
    })
    const llmChip = $('[data-llm-chip]')
    const mechChip = $('[data-mech-chip]')
    if (llmChip && mechChip) {
      llmChip.hidden = mode !== 'llm'
      mechChip.hidden = mode !== 'mechanical'
    }
  }

  // ── Step 5: spotlight tour ────────────────────────────────────────────────

  function startTour(stopIndex = 0) {
    state.inTour = true
    state.stop = Math.max(0, Math.min(TOUR.length - 1, stopIndex))
    body.dataset.mode = 'tour'
    spot.hidden = false
    renderTip()
    positionSpot(true)
    render()
    spotTip.querySelector('h2').focus({ preventScroll: true })
    syncHash()
  }

  function exitTour(choice, silent) {
    if (!state.inTour) return
    state.inTour = false
    spot.hidden = true
    body.dataset.mode = ''
    if (choice && !silent) markCurrent(choice)
    render()
    syncHash()
  }

  function tourNext() {
    if (state.stop < TOUR.length - 1) {
      state.stop += 1
      renderTip()
      positionSpot(false)
      render()
      syncHash()
    } else {
      markCurrent('done')
      exitTour(null)
      gotoStep(6, { keepHash: true })
      toast('Tour complete — the panel picks up at step 6.')
      syncHash()
    }
  }

  function tourPrev() {
    if (state.stop > 0) {
      state.stop -= 1
      renderTip()
      positionSpot(false)
      render()
      syncHash()
    }
  }

  function renderTip() {
    const stop = TOUR[state.stop]
    tipCount.textContent = `Stop ${state.stop + 1} of ${TOUR.length}`
    tipTitle.textContent = stop.title
    tipBody.textContent = stop.body
    $('#tipNext').textContent = state.stop === TOUR.length - 1 ? 'Finish the tour' : 'Next stop →'
    $('#tipBack').disabled = state.stop === 0
  }

  function positionSpot(instant) {
    const stop = TOUR[state.stop]
    const el = document.querySelector(stop.target)
    if (!el) return
    const pad = stop.pad || 8
    const r = el.getBoundingClientRect()
    const hole = {
      left: r.left - pad,
      top: r.top - pad,
      width: r.width + pad * 2,
      height: r.height + pad * 2,
    }
    if (instant) spotHole.classList.add('no-anim')
    spotHole.style.left = `${hole.left}px`
    spotHole.style.top = `${hole.top}px`
    spotHole.style.width = `${hole.width}px`
    spotHole.style.height = `${hole.height}px`
    if (instant) requestAnimationFrame(() => spotHole.classList.remove('no-anim'))

    // Tip: measure after content is current.
    const tipW = spotTip.offsetWidth || 330
    const tipH = spotTip.offsetHeight || 180
    const m = 14
    let left
    let top
    if (stop.place === 'right') {
      left = hole.left + hole.width + m
      top = hole.top + hole.height / 2 - tipH / 2
    } else if (stop.place === 'left') {
      left = hole.left - tipW - m
      top = hole.top + hole.height / 2 - tipH / 2
    } else if (stop.place === 'top') {
      left = hole.left + hole.width / 2 - tipW / 2
      top = hole.top - tipH - m
    } else {
      left = hole.left + hole.width / 2 - tipW / 2
      top = hole.top + hole.height + m
    }
    left = Math.max(16, Math.min(left, innerWidth - tipW - 16))
    top = Math.max(64, Math.min(top, innerHeight - tipH - 16))
    spotTip.style.left = `${left}px`
    spotTip.style.top = `${top}px`
  }

  // ── Step 6: background analysis ───────────────────────────────────────────

  const ANALYSIS_STEPS = [
    'Reading hardware — CPU, memory, GPU…',
    'OS and kernel…',
    'Services and listening ports…',
    'Writing the system context…',
  ]

  function startAnalysis() {
    if (state.analysis !== 'idle') return
    state.analysis = 'running'
    markCurrent('done')
    render()
    dock.hidden = false
    dockTitle.textContent = 'System analysis · running'
    dockFoot.hidden = true
    dockTag.hidden = false
    offerActions.hidden = true
    offerStatus.hidden = false
    offerStatus.textContent = 'Running in the background — keep going, you do not need to wait.'

    ANALYSIS_STEPS.forEach((text, i) => {
      later(() => {
        const li = document.createElement('li')
        li.innerHTML = i === ANALYSIS_STEPS.length - 1
          ? `<span class="busy">◐</span>${text}`
          : `<span class="tick">✓</span>${text}`
        dockLines.appendChild(li)
        if (i > 0) {
          const prevLi = dockLines.children[i - 1]
          if (prevLi) prevLi.innerHTML = `<span class="tick">✓</span>${ANALYSIS_STEPS[i - 1]}`
        }
        if (i === ANALYSIS_STEPS.length - 1) {
          later(() => {
            state.analysis = 'done'
            dockTitle.textContent = 'System analysis · ready'
            dockTag.hidden = true
            dockFoot.hidden = false
            dockLines.children[i].innerHTML = `<span class="tick">✓</span>${text}`
            if (state.step === 6) {
              offerStatus.textContent = '✓ System context ready — agents can now see this machine (sample data in this demo).'
            } else {
              toast('System analysis finished in the background — context is ready.')
            }
            render()
          }, 900)
        }
      }, 650 + i * 700)
    })
  }

  function skipAnalysis() {
    state.analysis = 'done'
    markCurrent('skipped')
    offerStatus.hidden = false
    offerStatus.textContent = 'Using the default system context. Ask Sysadmin to analyse the machine later.'
    offerActions.hidden = true
    render()
  }

  // ── Keyboard + hash ───────────────────────────────────────────────────────

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target
    if (t && t.closest && t.closest('input, textarea, select')) return
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault()
        next()
        break
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault()
        prev()
        break
      case 'Escape':
        if (!helpMask.hidden) { helpMask.hidden = true; break }
        e.preventDefault()
        skipStep()
        break
      case 'r':
      case 'R':
        reset()
        break
      case '?':
        helpMask.hidden = !helpMask.hidden
        break
      default:
        if (/^[1-7]$/.test(e.key)) {
          if (state.inTour) exitTour('skipped', true)
          gotoStep(Number(e.key))
        }
    }
  }

  function syncHash() {
    if (state.inTour) {
      writeHash(`step=5&stop=${state.stop}`)
    } else {
      writeHash(`step=${state.step}`)
    }
  }

  function writeHash(fragment) {
    try {
      history.replaceState(null, '', `#${fragment}`)
    } catch {
      /* file:// in some browsers refuses replaceState; deep links still work on load. */
    }
  }

  function applyHash() {
    const raw = location.hash.replace(/^#/, '')
    if (!raw) return null
    const params = new URLSearchParams(raw)
    const out = {}
    if (params.has('step')) out.step = Number(params.get('step'))
    if (params.has('stop')) out.stop = Number(params.get('stop'))
    if (params.get('run') === '1') out.run = true
    if (params.has('enable')) out.enable = params.get('enable')
    if (params.has('off')) out.off = params.get('off')
    if (params.has('view')) out.view = params.get('view')
    if (params.has('provider')) out.provider = params.get('provider')
    return out
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function bind() {
    $$('[data-next]').forEach((b) => b.addEventListener('click', next))
    $$('[data-back]').forEach((b) => b.addEventListener('click', prev))
    $$('[data-skip-step]').forEach((b) => b.addEventListener('click', skipStep))
    $$('[data-skip-all]').forEach((b) => b.addEventListener('click', skipAll))
    $$('#stepList [data-jump]').forEach((li, i) => {
      li.querySelector('button').addEventListener('click', () => gotoStep(i + 1))
    })
    $('#btnResetTop').addEventListener('click', reset)
    $('#btnDoneReset').addEventListener('click', reset)
    $('#btnHelp').addEventListener('click', () => { helpMask.hidden = !helpMask.hidden })
    $('#btnHelpClose').addEventListener('click', () => { helpMask.hidden = true })
    helpMask.addEventListener('click', (e) => { if (e.target === helpMask) helpMask.hidden = true })

    $$('#pModal .pcard').forEach((card) => card.addEventListener('click', () => {
      if (card.dataset.provider) { selectProvider(card.dataset.provider); return }
      if (card.dataset.heavy === 'freellmapi') { showProviderView('heavy'); return }
      toast('Demo mirror — FreeLLMAPI is the worked example; in the wired wizard every heavy row opens this same form.')
    }))
    $('#btnPBack').addEventListener('click', () => showProviderView('picker'))
    $('#btnPHeavyBack').addEventListener('click', () => showProviderView('picker'))
    $('#btnPDocsBack').addEventListener('click', () => showProviderView('heavy'))
    $('#btnPCreate').addEventListener('click', createProvider)
    $('#btnPHeavyCreate').addEventListener('click', () => {
      markCurrent('done')
      render()
      toast('Demo only — nothing was installed. In the real wizard this detects the instance or runs the install job.')
    })
    $('#btnPhDocs').addEventListener('click', () => showProviderView('heavydocs'))
    $('#phCheck').addEventListener('click', () => {
      const badge = $('#phHealth')
      badge.textContent = 'Checking…'
      later(() => { badge.textContent = 'Healthy · 200' }, 700)
    })
    $$('.ph-plat').forEach((b) => b.addEventListener('click', () => setProviderPlatform(b.dataset.plat)))

    $$('.radio').forEach((r) => r.addEventListener('click', () => {
      state.sandbox = r.dataset.mode
      $$('.radio').forEach((o) => o.setAttribute('aria-checked', String(o === r)))
      markCurrent('done')
      render()
    }))

    $$('.switch').forEach((sw) => sw.addEventListener('click', () => {
      setSwitch(sw, sw.getAttribute('aria-checked') !== 'true')
      markCurrent('done')
      render()
    }))
    $$('.seg-btn').forEach((b) => b.addEventListener('click', () => setCompactionMode(b.dataset.comp)))

    $('#btnAnalyse').addEventListener('click', startAnalysis)
    $('#btnSkipAnalyse').addEventListener('click', skipAnalysis)

    $('#tipNext').addEventListener('click', tourNext)
    $('#tipBack').addEventListener('click', tourPrev)
    $('#tipSkip').addEventListener('click', () => { markCurrent('skipped'); exitTour(null); gotoStep(6, { keepHash: true }) })

    const startBtn = document.querySelector('[data-start-tour]')
    if (startBtn) startBtn.addEventListener('click', () => startTour(0))

    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', () => { if (state.inTour) positionSpot(true) })
    window.addEventListener('hashchange', () => {
      // Deep-link updates from outside (or an address-bar edit).
      const h = applyHash()
      if (!h) return
      if (h.step && h.step !== state.step) gotoStep(h.step, { instant: true })
      if (h.step === 5 && h.stop !== undefined && !state.inTour) startTour(h.stop)
      if (h.step === 3) applyProviderHash(h)
      applyToggleHash(h)
    })
  }

  function boot() {
    bind()
    const h = applyHash()
    state.step = h && h.step >= 1 && h.step <= 7 ? h.step : 1
    render()
    if (h && h.step === 5 && h.stop !== undefined) startTour(h.stop)
    if (h && h.step === 6 && h.run) startAnalysis()
    applyToggleHash(h)
    applyProviderHash(h)
  }

  function applyToggleHash(h) {
    if (!h) return
    if (h.enable) {
      h.enable.split(',').forEach((feature) => {
        const sw = document.querySelector(`.toggle-card[data-feature="${feature}"] .switch`)
        if (sw) setSwitch(sw, true)
      })
    }
    if (h.off) {
      h.off.split(',').forEach((feature) => {
        const sw = document.querySelector(`.toggle-card[data-feature="${feature}"] .switch`)
        if (sw) setSwitch(sw, false)
      })
    }
    updateIntelButton()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
