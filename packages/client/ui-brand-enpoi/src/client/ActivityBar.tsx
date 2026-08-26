import { useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import css from './ActivityBar.module.css'

interface BetterSidebarService {
  getSnapshot(): { state?: { panelOpen?: boolean; bottomOpen?: boolean; splits?: unknown } }
  subscribe(listener: () => void): () => void
  subscribeState?(listener: () => void): () => void
  openTab(seed: { type: string; title?: string }): void
  activateTab?(tabId: string): void
}

function getRightToggleBtn(): HTMLButtonElement | null {
  const host = document.querySelector('[data-dsh-panel-host]')
  if (!host) {
    return document.querySelector('button[aria-label*="侧拉"], button[aria-label*="展开"], button[aria-label*="折叠"], button[aria-label*="collapse"], button[aria-label*="expand"]') as HTMLButtonElement | null
  }
  const clusterBtns = host.querySelectorAll('div[class*="toggleCluster"] button')
  if (clusterBtns.length > 0) {
    return clusterBtns[clusterBtns.length - 1] as HTMLButtonElement
  }
  const allBtns = host.querySelectorAll('button')
  return allBtns.length > 0 ? (allBtns[allBtns.length - 1] as HTMLButtonElement) : null
}

function getBottomToggleBtn(): HTMLButtonElement | null {
  const host = document.querySelector('[data-dsh-panel-host]')
  if (!host) return null
  const clusterBtns = host.querySelectorAll('div[class*="toggleCluster"] button')
  if (clusterBtns.length > 1) {
    return clusterBtns[0] as HTMLButtonElement
  }
  return null
}

export function ActivityBar({ ctx }: { ctx: ClientContext }) {
  const [activeType, setActiveType] = useState<string>('editor')
  const [panelOpen, setPanelOpen] = useState<boolean>(false)
  const [bottomOpen, setBottomOpen] = useState<boolean>(false)

  useEffect(() => {
    const checkState = () => {
      const host = document.querySelector('[data-dsh-panel-host]')
      const rightPanel = host?.querySelector('div[class*="panel"]:not([class*="bottomPanel"])') as HTMLElement | null
      const isRightOpen = rightPanel !== null && !rightPanel.className.includes('panelHidden') && rightPanel.style.visibility !== 'hidden'
      setPanelOpen(isRightOpen)

      const bottomPanel = host?.querySelector('div[class*="bottomPanel"]') as HTMLElement | null
      const isBottomOpen = bottomPanel !== null && !bottomPanel.className.includes('bottomPanelHidden') && bottomPanel.style.visibility !== 'hidden'
      setBottomOpen(isBottomOpen)

      // Find active tab type
      const activeTabEl = document.querySelector('div[class*="paneTab"]:not([class*="paneTabHidden"])')
      if (activeTabEl) {
        if (activeTabEl.querySelector('div[class*="TreePanel"]') || activeTabEl.querySelector('div[class*="TextEditor"]') || activeTabEl.querySelector('div[class*="EditorHost"]')) {
          setActiveType('editor')
        } else if (activeTabEl.querySelector('div[class*="GitView"]') || activeTabEl.querySelector('div[class*="DiffTab"]')) {
          setActiveType('git')
        } else if (activeTabEl.querySelector('div[class*="TerminalView"]') || activeTabEl.querySelector('.xterm')) {
          setActiveType('terminal')
        } else if (activeTabEl.querySelector('div[class*="SubagentView"]')) {
          setActiveType('subagent')
        } else if (activeTabEl.querySelector('div[class*="BrowserView"]')) {
          setActiveType('browser')
        } else if (activeTabEl.querySelector('div[class*="CapabilitiesDrawer"]') || activeTabEl.querySelector('[class*="Capabilities"]') || activeTabEl.textContent?.includes('Capabilities Control Center')) {
          setActiveType('capabilities')
        }
      }
    }

    const observer = new MutationObserver(checkState)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
    checkState()

    const interval = setInterval(checkState, 250)
    return () => {
      observer.disconnect()
      clearInterval(interval)
    }
  }, [])

  const handleToolClick = (toolId: string, toolTitle: string) => {
    const betterSidebar = ctx.get('betterSidebar') as BetterSidebarService | undefined
    const host = document.querySelector('[data-dsh-panel-host]')
    const rightPanel = host?.querySelector('div[class*="panel"]:not([class*="bottomPanel"])') as HTMLElement | null
    const isRightOpen = rightPanel !== null && !rightPanel.className.includes('panelHidden') && rightPanel.style.visibility !== 'hidden'
    const rightBtn = getRightToggleBtn()

    if (isRightOpen && activeType === toolId) {
      // Collapse panel if clicking active tool
      rightBtn?.click()
    } else {
      // Open tab
      if (betterSidebar) {
        betterSidebar.openTab({ type: toolId, title: toolTitle })
      }
      if (!isRightOpen) {
        rightBtn?.click()
      }
      setActiveType(toolId)
    }
  }

  const handleBottomToggle = () => {
    const bottomBtn = getBottomToggleBtn()
    bottomBtn?.click()
  }

  const tools = [
    {
      id: 'editor',
      title: 'Files / Explorer',
      icon: (
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 3.5C2 2.67157 2.67157 2 3.5 2H6.08579C6.48362 2 6.86514 2.15804 7.14645 2.43934L8.56066 3.85355C8.84196 4.13486 9.22348 4.29289 9.62132 4.29289H12.5C13.3284 4.29289 14 4.96446 14 5.79289V12.5C14 13.3284 13.3284 14 12.5 14H3.5C2.67157 14 2 13.3284 2 12.5V3.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      id: 'git',
      title: 'Source Control / Git',
      icon: (
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="4.5" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="4.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="11.5" cy="7" r="2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M4.5 6V10M4.5 6C4.5 7.5 7 8 11.5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      id: 'terminal',
      title: 'Persistent Terminal',
      icon: (
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
          <path d="M4.5 6.25L7 8L4.5 9.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.5 10.5H11.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      id: 'subagent',
      title: 'Tasks / Subagents',
      icon: (
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5.5 8H10.5M8 5.5V10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      id: 'browser',
      title: 'Browser View',
      icon: (
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
          <path d="M2.5 8H13.5M8 2C9.5 4 10.5 6 10.5 8C10.5 10 9.5 12 8 14C6.5 12 5.5 10 5.5 8C5.5 6 6.5 4 8 2Z" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      ),
    },
    {
      id: 'capabilities',
      title: 'Capabilities & Tools',
      icon: (
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M6 2.5C6 1.94772 6.44772 1.5 7 1.5H9C9.55228 1.5 10 1.94772 10 2.5V3.5H12.5C13.0523 3.5 13.5 3.94772 13.5 4.5V7C14.0523 7 14.5 7.44772 14.5 8V10C14.5 10.5523 14.0523 11 13.5 11V13.5C13.5 14.0523 13.0523 14.5 12.5 14.5H10V13.5C10 12.9477 9.55228 12.5 9 12.5H7C6.44772 12.5 6 12.9477 6 13.5V14.5H3.5C2.94772 14.5 2.5 14.0523 2.5 13.5V11C1.94772 11 1.5 10.5523 1.5 10V8C1.5 7.44772 1.94772 7 2.5 7V4.5C2.5 3.94772 2.94772 3.5 3.5 3.5H6V2.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      ),
    },
  ]

  return (
    <aside className={css.activityRail} aria-label="Workbench Activity Bar">
      <div className={css.topGroup}>
        {tools.map((tool) => {
          const isActive = panelOpen && activeType === tool.id
          return (
            <button
              key={tool.id}
              type="button"
              className={`${css.activityButton} ${isActive ? css.activityButtonActive : ''}`}
              title={tool.title}
              aria-label={tool.title}
              onClick={() => handleToolClick(tool.id, tool.title)}
            >
              {tool.icon}
            </button>
          )
        })}
      </div>
      <div className={css.bottomGroup}>
        <button
          type="button"
          className={`${css.activityButton} ${bottomOpen ? css.activityButtonActive : ''}`}
          title={bottomOpen ? 'Collapse Bottom Panel' : 'Expand Bottom Panel'}
          aria-label={bottomOpen ? 'Collapse Bottom Panel' : 'Expand Bottom Panel'}
          onClick={handleBottomToggle}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1.5" y="2" width="13" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
            <rect x="3.25" y="10" width="9.5" height="2.75" rx="1" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>
    </aside>
  )
}
