/** Root-scoped controller for the right Sidebar's Session content. */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../contract/slots.ts'

/**
 * Render the Session-bound Sidebar only while the Conversation is selected.
 * @param props - frame geometry, panel selection, and the authorized Session renderer.
 * @returns the current Session's right Sidebar, or no content for a global panel.
 */
export function RightbarRoot({
  usePanelInfo, SessionProvider, renderSlot, width, viewportWidth, canShow, mobile,
}: PropsRuntime<'rightbar'> & PropsRenderSlots<'rightbar.session'>) {
  const visible = usePanelInfo(info => info.activePanelId === null)
  if (!visible) return null
  // One mounted Conversation at a time: this seat's view is the active one, and
  // tab retention stays a no-op until background Session views are adopted.
  return (
    <SessionProvider>
      {renderSlot('rightbar.session', {
        width, viewportWidth, canShow, mobile,
        active: true,
        retainTab: () => () => {},
      })}
    </SessionProvider>
  )
}
