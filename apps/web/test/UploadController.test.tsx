import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { UploadController, splitConflicts, type UploadHandle } from '../src/apps/files/UploadController.js';

vi.mock('../src/lib/api.js', () => ({
  cloudUpload: vi.fn(),
}));
import * as api from '../src/lib/api.js';

describe('splitConflicts', () => {
  it('separates conflicting from fresh by virtual_path', () => {
    const { conflicts, fresh } = splitConflicts(
      [{ name: 'a.csv' }, { name: 'b.csv' }] as File[],
      'inbox/',
      new Set(['inbox/a.csv']),
    );
    expect(conflicts.map(c => c.name)).toEqual(['a.csv']);
    expect(fresh.map(c => c.name)).toEqual(['b.csv']);
  });
});

describe('UploadController', () => {
  beforeEach(() => { vi.mocked(api.cloudUpload).mockReset(); vi.mocked(api.cloudUpload).mockResolvedValue({ ok: true, virtual_path: 'x', size: 1, last_modified: 'x' }); });

  function setup(existing: string[] = []) {
    const ref = createRef<UploadHandle>();
    const onUploaded = vi.fn();
    render(
      <UploadController
        ref={ref}
        currentPath="inbox/"
        existingPaths={new Set(existing)}
        onUploaded={onUploaded}
      />
    );
    return { ref, onUploaded };
  }

  it('uploads fresh files directly (no conflict modal)', async () => {
    const { ref, onUploaded } = setup([]);
    const file = new File(['x'], 'new.csv', { type: 'text/csv' });
    ref.current!.uploadFiles([file]);
    await waitFor(() => expect(api.cloudUpload).toHaveBeenCalledWith(file, 'inbox/new.csv', expect.any(Object)));
    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
  });

  it('shows conflict modal and "全部覆盖" overwrites', async () => {
    const { ref } = setup(['inbox/dup.csv']);
    const file = new File(['x'], 'dup.csv', { type: 'text/csv' });
    ref.current!.uploadFiles([file]);
    await waitFor(() => expect(screen.getByText(/已存在/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('全部覆盖'));
    await waitFor(() => expect(api.cloudUpload).toHaveBeenCalledWith(file, 'inbox/dup.csv', expect.any(Object)));
  });

  it('"跳过已存在" does not upload the conflicting file', async () => {
    const { ref } = setup(['inbox/dup.csv']);
    const dup = new File(['x'], 'dup.csv', { type: 'text/csv' });
    const fresh = new File(['y'], 'ok.csv', { type: 'text/csv' });
    ref.current!.uploadFiles([dup, fresh]);
    await waitFor(() => expect(screen.getByText(/已存在/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('跳过已存在'));
    await waitFor(() => expect(api.cloudUpload).toHaveBeenCalledWith(fresh, 'inbox/ok.csv', expect.any(Object)));
    expect(api.cloudUpload).not.toHaveBeenCalledWith(dup, 'inbox/dup.csv', expect.any(Object));
  });

  it('"取消" uploads nothing', async () => {
    const { ref } = setup(['inbox/dup.csv']);
    const dup = new File(['x'], 'dup.csv', { type: 'text/csv' });
    ref.current!.uploadFiles([dup]);
    await waitFor(() => expect(screen.getByText(/已存在/)).toBeInTheDocument());
    fireEvent.click(screen.getByText('取消'));
    expect(api.cloudUpload).not.toHaveBeenCalled();
  });
});
