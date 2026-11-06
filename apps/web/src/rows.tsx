import { splitInbox } from '@planb/shared';
import type { EventOut, InboxOut, Item, NoteOut, TaskOut } from '@planb/shared';
import { useApp } from './app-context';
import { nav } from './nav';
import { completeTask, mutate, removeItem } from './queries';
import { t } from './ru';
import { CatLabel, Check, SwipeRow, catStyle } from './ui';
import { dayLabel, firstLine } from './util';

export function TaskRow({ task, showDate }: { task: TaskOut; showDate?: boolean }) {
  const { today } = useApp();
  const late = !!task.due_date && task.due_date < today && task.status === 'open';
  const done = task.checklist.filter((i) => i.done).length;
  const when = [showDate && task.due_date ? dayLabel(task.due_date, today) : null, task.due_time].filter(Boolean).join(', ');
  return (
    <SwipeRow rightLabel={t.done} leftLabel={t.rescheduleTitle}
      onRight={task.status === 'open' ? () => completeTask(task) : undefined}
      onLeft={task.status === 'open' ? () => nav.push({ t: 'reschedule', task }) : undefined}>
      <div className={`row ${task.status === 'done' ? 'done' : ''}`} role="button" tabIndex={0}
        onClick={() => nav.push({ t: 'task', id: task.id, task })} onKeyDown={(e) => e.key === 'Enter' && nav.push({ t: 'task', id: task.id, task })}>
        <Check done={task.status === 'done'} label={t.done}
          onClick={() => (task.status === 'open' ? completeTask(task) : void mutate(`/tasks/${task.id}`, 'PATCH', { status: 'open' }))} />
        <div className="row-main">
          <div className="row-title">{task.title}</div>
          <div className="row-meta">
            {when && <span className={late ? 'late' : ''}>{when}</span>}
            <CatLabel id={task.category_id} />
            {task.checklist.length > 0 && <span>{done}/{task.checklist.length}</span>}
          </div>
        </div>
      </div>
    </SwipeRow>
  );
}

export function EventRow({ event, showDate }: { event: EventOut; showDate?: boolean }) {
  const { today, catMap } = useApp();
  const time = event.all_day ? t.allDay : [event.start_time, event.end_time].filter(Boolean).join('–');
  return (
    <SwipeRow leftLabel={t.delete} onLeft={() => removeItem('events', event.id)}>
      <div className="row" role="button" tabIndex={0} onClick={() => nav.push({ t: 'event', id: event.id, event })} onKeyDown={(e) => e.key === 'Enter' && nav.push({ t: 'event', id: event.id, event })}>
        <span className="ev-bar c" style={catStyle(catMap[event.category_id]?.color)} />
        <div className="row-main">
          <div className="row-title">{event.title}</div>
          <div className="row-meta">
            <span>{showDate ? `${dayLabel(event.start_date, today)}, ${time}` : time}</span>
            {event.location && <span>{event.location}</span>}
            <CatLabel id={event.category_id} />
          </div>
        </div>
      </div>
    </SwipeRow>
  );
}

export const ItemRow = ({ item, showDate }: { item: Item; showDate?: boolean }) =>
  item.kind === 'task' ? <TaskRow task={item.task} showDate={showDate} /> : <EventRow event={item.event} showDate={showDate} />;

export function NoteCard({ note }: { note: NoteOut }) {
  const title = note.title || firstLine(note.body);
  const preview = note.title ? note.body : note.body.split('\n').slice(1).join('\n');
  return (
    <SwipeRow rightLabel={note.pinned ? t.unpin : t.pin} leftLabel={t.delete}
      onRight={() => void mutate(`/notes/${note.id}`, 'PATCH', { pinned: !note.pinned })} onLeft={() => removeItem('notes', note.id)}>
      <div className="row note" role="button" tabIndex={0} onClick={() => nav.push({ t: 'note', id: note.id, note })} onKeyDown={(e) => e.key === 'Enter' && nav.push({ t: 'note', id: note.id, note })}>
        <div className="row-main">
          <div className="row-title">{note.pinned && <span className="pin">●</span>}{title}</div>
          {preview.trim() && <div className="note-preview">{preview}</div>}
          <div className="row-meta"><CatLabel id={note.category_id} /></div>
        </div>
      </div>
    </SwipeRow>
  );
}

export function InboxRow({ item }: { item: InboxOut }) {
  const title = firstLine(item.text) || item.attachments[0]?.caption || t.inbox;
  const toTask = () => nav.push({ t: 'task', draft: splitInbox(item.text || title), inboxId: item.id });
  return (
    <SwipeRow rightLabel={t.toTask} leftLabel={t.toNote} onRight={toTask}
      onLeft={() => void mutate(`/inbox/${item.id}/convert`, 'POST', { to: 'note', id: crypto.randomUUID() })}>
      <div className="row" role="button" tabIndex={0} onClick={() => nav.push({ t: 'inboxItem', item })}>
        <div className="row-main">
          <div className="row-title clamp">{item.text || title}</div>
          <div className="row-meta">
            {item.forward_origin && <span>{t.fromForward}{item.forward_origin}</span>}
            {item.attachments.length > 0 && <span>Вложений: {item.attachments.length}</span>}
            <span>{new Date(item.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      </div>
    </SwipeRow>
  );
}
