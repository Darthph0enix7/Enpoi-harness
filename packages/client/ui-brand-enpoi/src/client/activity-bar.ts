import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import css from './ActivityBar.module.css'

/** CSS-module index access is `string | undefined` under noUncheckedIndexedAccess; module keys are static. */
function cls(name: string | undefined): string {
  return name ?? ''
}

interface BetterSidebarService {
  getSnapshot(): { state?: { panelOpen?: boolean; bottomOpen?: boolean; splits?: unknown } }
  subscribe(listener: () => void): () => void
  subscribeState?(listener: () => void): () => void
  openTab(seed: { type: string; title?: string }): void
  activateTab?(tabId: string): void
}

const TOOLS = [
  {
    id: 'editor',
    title: 'Files / Explorer',
    svg: `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 3.5C2 2.67157 2.67157 2 3.5 2H6.08579C6.48362 2 6.86514 2.15804 7.14645 2.43934L8.56066 3.85355C8.84196 4.13486 9.22348 4.29289 9.62132 4.29289H12.5C13.3284 4.29289 14 4.96446 14 5.79289V12.5C14 13.3284 13.3284 14 12.5 14H3.5C2.67157 14 2 13.3284 2 12.5V3.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>`,
  },
  {
    id: 'git',
    title: 'Source Control / Git',
    svg: `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="4.5" cy="4" r="2" stroke="currentColor" stroke-width="1.4"/>
      <circle cx="4.5" cy="12" r="2" stroke="currentColor" stroke-width="1.4"/>
      <circle cx="11.5" cy="7" r="2" stroke="currentColor" stroke-width="1.4"/>
      <path d="M4.5 6V10M4.5 6C4.5 7.5 7 8 11.5 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'terminal',
    title: 'Persistent Terminal',
    svg: `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" stroke-width="1.4"/>
      <path d="M4.5 6.25L7 8L4.5 9.75" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8.5 10.5H11.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'subagent',
    title: 'Tasks / Subagents',
    svg: `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/>
      <path d="M5.5 8H10.5M8 5.5V10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`,
  },
  {
    id: 'browser',
    title: 'Browser View',
    svg: `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/>
      <path d="M2.5 8H13.5M8 2C9.5 4 10.5 6 10.5 8C10.5 10 9.5 12 8 14C6.5 12 5.5 10 5.5 8C5.5 6 6.5 4 8 2Z" stroke="currentColor" stroke-width="1.4"/>
    </svg>`,
  },
]

function getRightToggleBtn(): HTMLButtonElement | null {
  const host = document.querySelector('[data-dsh-panel-host]')
  const bySvg = host?.querySelector('svg rect[x="10.5"]')?.closest('button') || document.querySelector('svg rect[x="10.5"]')?.closest('button')
  if (bySvg) return bySvg as HTMLButtonElement
  const cluster = host?.querySelector('div[class*="toggleCluster"]')
  if (cluster && cluster.children.length > 0) return cluster.children[cluster.children.length - 1] as HTMLButtonElement
  const allBtns = host?.querySelectorAll('button')
  return allBtns && allBtns.length > 0 ? (allBtns[allBtns.length - 1] as HTMLButtonElement) : null
}

function getBottomToggleBtn(): HTMLButtonElement | null {
  const host = document.querySelector('[data-dsh-panel-host]')
  const bySvg = host?.querySelector('svg rect[y="10"]')?.closest('button') || document.querySelector('svg rect[y="10"]')?.closest('button')
  if (bySvg) return bySvg as HTMLButtonElement
  const cluster = host?.querySelector('div[class*="toggleCluster"]')
  if (cluster && cluster.children.length > 1) return cluster.children[0] as HTMLButtonElement
  return null
}

export function mountActivityBar(ctx: ClientContext): () => void {
  let rail = document.getElementById('enpoi-activity-bar') as HTMLElement | null
  if (rail) return () => rail?.remove()

  rail = document.createElement('aside')
  rail.id = 'enpoi-activity-bar'
  rail.className = cls(css.activityRail)
  rail.setAttribute('aria-label', 'Workbench Activity Bar')

  const topGroup = document.createElement('div')
  topGroup.className = cls(css.topGroup)

  const toolButtons: Map<string, HTMLButtonElement> = new Map()

  let currentActiveType = 'editor'
  let isRightPanelOpen = false

  const updateActiveUI = () => {
    for (const [id, btn] of toolButtons.entries()) {
      if (isRightPanelOpen && currentActiveType === id) {
        btn.classList.add(cls(css.activityButtonActive))
      } else {
        btn.classList.remove(cls(css.activityButtonActive))
      }
    }
  }

  for (const tool of TOOLS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = cls(css.activityButton)
    btn.title = tool.title
    btn.setAttribute('aria-label', tool.title)
    btn.innerHTML = tool.svg

    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const betterSidebar = ctx.get('betterSidebar') as BetterSidebarService | undefined
      const host = document.querySelector('[data-dsh-panel-host]')
      const panel = host?.querySelector('div[class*="panel"]:not([class*="bottomPanel"])') as HTMLElement | null
      const isOpen = panel !== null && (typeof panel.className === 'string' ? !panel.className.includes('panelHidden') : true) && panel.style.visibility !== 'hidden'
      const rightToggleBtn = getRightToggleBtn()

      if (isOpen && currentActiveType === tool.id) {
        // Collapse panel if clicking active tool
        rightToggleBtn?.click()
      } else {
        // Open tab
        if (betterSidebar) {
          betterSidebar.openTab({ type: tool.id, title: tool.title })
        }
        if (!isOpen) {
          rightToggleBtn?.click()
        }
        currentActiveType = tool.id
        isRightPanelOpen = true
        updateActiveUI()
      }
    })

    toolButtons.set(tool.id, btn)
    topGroup.appendChild(btn)
  }

  const bottomGroup = document.createElement('div')
  bottomGroup.className = cls(css.bottomGroup)

  const bottomBtn = document.createElement('button')
  bottomBtn.type = 'button'
  bottomBtn.className = cls(css.activityButton)
  bottomBtn.title = 'Toggle Bottom Panel'
  bottomBtn.setAttribute('aria-label', 'Toggle Bottom Panel')
  bottomBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" stroke-width="1.4"/>
    <rect x="3.25" y="10" width="9.5" height="2.75" rx="1" fill="currentColor" stroke="none"/>
  </svg>`

  bottomBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const bottomToggleBtn = getBottomToggleBtn()
    bottomToggleBtn?.click()
  })

  bottomGroup.appendChild(bottomBtn)

  rail.appendChild(topGroup)
  rail.appendChild(bottomGroup)
  document.body.appendChild(rail)

  // Observer to track better-sidebar open/closed & active tab states
  const checkState = () => {
    const host = document.querySelector('[data-dsh-panel-host]')
    const rightPanel = host?.querySelector('div[class*="panel"]:not([class*="bottomPanel"])') as HTMLElement | null
    isRightPanelOpen = rightPanel !== null && (typeof rightPanel.className === 'string' ? !rightPanel.className.includes('panelHidden') : true) && rightPanel.style.visibility !== 'hidden'

    const bottomPanel = host?.querySelector('div[class*="bottomPanel"]') as HTMLElement | null
    const isBottomOpen = bottomPanel !== null && (typeof bottomPanel.className === 'string' ? !bottomPanel.className.includes('bottomPanelHidden') : true) && bottomPanel.style.visibility !== 'hidden'
    if (isBottomOpen) {
      bottomBtn.classList.add(cls(css.activityButtonActive))
    } else {
      bottomBtn.classList.remove(cls(css.activityButtonActive))
    }

    const activeTabEl = document.querySelector('div[class*="paneTab"]:not([class*="paneTabHidden"])')
    if (activeTabEl) {
      if (activeTabEl.querySelector('div[class*="TreePanel"]') || activeTabEl.querySelector('div[class*="TextEditor"]') || activeTabEl.querySelector('div[class*="EditorHost"]')) {
        currentActiveType = 'editor'
      } else if (activeTabEl.querySelector('div[class*="GitView"]') || activeTabEl.querySelector('div[class*="DiffTab"]')) {
        currentActiveType = 'git'
      } else if (activeTabEl.querySelector('div[class*="TerminalView"]') || activeTabEl.querySelector('.xterm')) {
        currentActiveType = 'terminal'
      } else if (activeTabEl.querySelector('div[class*="SubagentView"]')) {
        currentActiveType = 'subagent'
      } else if (activeTabEl.querySelector('div[class*="BrowserView"]')) {
        currentActiveType = 'browser'
      }
    }
    updateActiveUI()
  }

  const observer = new MutationObserver(checkState)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  checkState()

  const interval = setInterval(checkState, 300)

  return () => {
    observer.disconnect()
    clearInterval(interval)
    rail?.remove()
  }
}
