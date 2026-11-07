import type { FeedEvent, Notification } from '../data/types'
import { Icon } from './Icon'

export function Feed({ events }: { events: FeedEvent[] }) {
  return (
    <div className="feed">
      {events.map((f, i) => (
        <div className="ev" key={`${i}-${f.text}`}>
          <span className="ava">
            <Icon name={f.icon} />
          </span>
          <div>
            <b className="bit" style={{ fontSize: 15 }}>
              {f.who}
            </b>{' '}
            {f.text}
            <div className="t num">
              {f.at} · <a href="#wallet">receipt</a>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function Notifications({ items }: { items: Notification[] }) {
  return (
    <div className="feed">
      {items.map((n) => (
        <div className="ev" key={n.text}>
          <span className="ava">
            <Icon name={n.icon} />
          </span>
          <div>
            {n.text}
            <div className="t num">{n.at}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
