import { CLIENT_TAG_DESCRIPTIONS, CLIENT_TAG_LIST, normalizeClientTags, toggleClientTag } from '../domain/clientTags';

/* ------------------------------------------------------------------------- *
 * Checkboxes, not a dropdown, because a client can be more than one thing.
 *
 * "At risk and refund save" is not a contradiction, it is the most important
 * row on the page: a client the firm already paid to keep, now slipping again.
 * A single-select control would have made that unsayable.
 *
 * Each one carries its meaning beside it. Three CAMs guessing separately at
 * what "at risk" means produces a column nobody can count, which is the whole
 * failure mode tagging exists to avoid.
 * ------------------------------------------------------------------------- */
export default function ClientTagPicker({ tags, onChange, disabled = false }) {
  const current = normalizeClientTags(tags);
  return (
    <div className="client-tag-picker">
      <div className="client-tag-picker-label">Tags</div>
      <div className="client-tag-options">
        {CLIENT_TAG_LIST.map((tag) => {
          const checked = current.includes(tag);
          return (
            <label
              key={tag}
              className={`client-tag-option${checked ? ' checked' : ''}`}
              title={CLIENT_TAG_DESCRIPTIONS[tag]}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => onChange?.(toggleClientTag(current, tag))}
              />
              <span className="client-tag-name">{tag}</span>
              <span className="client-tag-why">{CLIENT_TAG_DESCRIPTIONS[tag]}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
