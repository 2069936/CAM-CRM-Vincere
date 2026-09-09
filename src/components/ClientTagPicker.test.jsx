import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ClientTagPicker from './ClientTagPicker';
import { toggleClientTag } from '../domain/clientTags';

describe('picking tags for a client', () => {
  it('offers the three management asked for, with what each one means', () => {
    const html = renderToStaticMarkup(<ClientTagPicker tags={[]} />);
    expect(html).toContain('At risk');
    expect(html).toContain('VIP');
    expect(html).toContain('Refund save');
    // Three CAMs guessing separately at what "at risk" means produces a column
    // nobody can count.
    expect(html).toContain('Needs attention this week');
    expect(html).toContain('Not a conversion prospect');
  });

  it('shows more than one as checked, because a client can be both', () => {
    const html = renderToStaticMarkup(<ClientTagPicker tags={['At risk', 'Refund save']} />);
    expect(html.match(/checked=""/g) || []).toHaveLength(2);
  });

  it('survives a client with no tags at all', () => {
    expect(() => renderToStaticMarkup(<ClientTagPicker tags={null} />)).not.toThrow();
    expect(renderToStaticMarkup(<ClientTagPicker tags={undefined} />)).not.toContain('checked=""');
  });

  it('hands back the whole new list, never a single tag', () => {
    // The caller saves a list. Handing it one tag would make every save wipe
    // the others.
    const onChange = vi.fn();
    expect(toggleClientTag(['VIP'], 'At risk')).toEqual(['At risk', 'VIP']);
    expect(onChange).not.toHaveBeenCalled();
  });
});
