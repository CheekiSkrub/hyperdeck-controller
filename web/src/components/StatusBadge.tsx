const LABELS: Record<string, string> = {
  preview: 'PREVIEW', stopped: 'STOPPED', play: 'PLAY', forward: 'FWD', rewind: 'REW', jog: 'JOG', shuttle: 'SHUTTLE', record: 'REC',
};

export function StatusBadge({ status, small }: { status: string; small?: boolean }) {
  return <span className={`badge status-${status} ${small ? 'small' : ''}`}>{LABELS[status] ?? status.toUpperCase()}</span>;
}
