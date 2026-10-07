import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getTotalMemory, getUsedMemory } from 'react-native-device-info';
import { getLlmService } from '../ai/llm';
import { getModelManager } from '../ai/modelManager';
import { getRobotClient } from '../robot/useRobot';
import type { UseRobot } from '../robot/useRobot';
import { exportLog } from '../util/log';
import type { UseAudio } from '../voice/useAudio';

export interface DiagnosticsScreenProps {
  robot: UseRobot;
  audio: UseAudio;
  onBack: () => void;
}

/**
 * Field-debug view: link, audio, brain, memory + log export. Polls RSSI/RAM
 * every 2 s while open (not in the main loop — readRSSI is a BLE round-trip).
 */
export default function DiagnosticsScreen({ robot, audio, onBack }: DiagnosticsScreenProps) {
  const [rssi, setRssi] = useState<number | null>(null);
  const [mem, setMem] = useState<{ used: number | null; total: number | null }>({
    used: null,
    total: null,
  });
  const [logPath, setLogPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (robot.robotStatus.isConnected) {
        const r = await getRobotClient().readRSSI();
        if (alive) setRssi(r);
      } else if (alive) {
        setRssi(null);
      }
      try {
        const [used, total] = await Promise.all([getUsedMemory(), getTotalMemory()]);
        if (alive) setMem({ used, total });
      } catch {
        // device-info unavailable — leave dashes.
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [robot.robotStatus.isConnected]);

  const hbAt = getRobotClient().lastWriteAtMs;
  const hbAge = hbAt === null ? null : Math.max(0, Date.now() - hbAt);
  const bench = getLlmService().lastBench;
  const llm = getLlmService();
  const model = getModelManager().getSelected();

  const Row = ({ k, v }: { k: string; v: string }) => (
    <View style={styles.row}>
      <Text style={styles.k}>{k}</Text>
      <Text style={styles.v} numberOfLines={2}>
        {v}
      </Text>
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backText}>‹ settings</Text>
        </Pressable>
        <Text style={styles.title}>diagnostics</Text>
      </View>

      <Text style={styles.section}>ble link</Text>
      <Row k="state" v={robot.connState} />
      <Row k="rssi" v={rssi === null ? '—' : `${rssi} dBm`} />
      <Row
        k="last write"
        v={hbAge === null ? 'never' : `${hbAge} ms ago (cmd or heartbeat)`}
      />
      <Row
        k="last status"
        v={
          robot.link
            ? `${robot.link.state} · batt ${robot.link.batt}% · ${Math.max(0, Date.now() - robot.link.at)} ms ago`
            : 'no notify yet'
        }
      />
      {robot.error && <Row k="error" v={`${robot.error.code}: ${robot.error.message}`} />}

      <Text style={styles.section}>audio machine</Text>
      <Row k="phase" v={`${audio.phase}${audio.running ? '' : ' (stopped)'}`} />
      <Row k="last heard" v={audio.lastHeard === '' ? '—' : `“${audio.lastHeard}”`} />
      <Row
        k="detections"
        v={
          audio.detections.length === 0
            ? 'none'
            : audio.detections
                .slice(0, 3)
                .map((d) => d.label)
                .join(', ')
        }
      />
      {audio.error && <Row k="error" v={`${audio.error.code}: ${audio.error.message}`} />}

      <Text style={styles.section}>brain</Text>
      <Row k="model" v={`${model.label} · ${llm.isLoaded ? 'resident' : 'unloaded'}`} />
      <Row
        k="tok/s"
        v={
          bench
            ? `${bench.tokensPerSec.toFixed(1)} decode · ttft ${bench.ttftMs} ms`
            : 'no benchmark yet (settings → benchmark)'
        }
      />

      <Text style={styles.section}>device</Text>
      <Row
        k="ram"
        v={
          mem.used === null || mem.total === null
            ? '—'
            : `${(mem.used / 1e9).toFixed(2)} / ${(mem.total / 1e9).toFixed(1)} GB used`
        }
      />

      <Pressable
        style={styles.testBtn}
        onPress={() => {
          void exportLog()
            .then((p) => setLogPath(p))
            .catch((e) => setLogPath(`export failed: ${String(e)}`));
        }}
      >
        <Text style={styles.testText}>export log (ring buffer, 300)</Text>
      </Pressable>
      {logPath && (
        <Text style={styles.note} selectable>
          {logPath}
        </Text>
      )}
      <Text style={styles.note}>
        pull with: adb pull /data/data/com.wii.robot/files/&lt;name&gt;
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#04060c', padding: 16, gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  backBtn: { backgroundColor: '#1a2740', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  backText: { color: '#e9f2ff', fontSize: 14 },
  title: { color: '#e9f2ff', fontSize: 18, fontWeight: '700' },
  section: { color: '#9fb6d8', fontSize: 12, marginTop: 10, textTransform: 'uppercase' },
  row: { flexDirection: 'row', gap: 8 },
  k: { color: '#5b7192', fontSize: 12, width: 90 },
  v: { color: '#e9f2ff', fontSize: 12, flex: 1 },
  note: { color: '#5b7192', fontSize: 11 },
  testBtn: { backgroundColor: '#1a2740', borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginTop: 8 },
  testText: { color: '#e9f2ff', fontSize: 14, fontWeight: '600' },
});
