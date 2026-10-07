import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { UseAudio } from '../voice/useAudio';
import type { UseRobot } from '../robot/useRobot';
import DiagnosticsScreen from './DiagnosticsScreen';
import {
  getWakeSettings,
  onWakeSettings,
  setWakeSettings,
  type WakeSettings,
} from '../voice/settings';
import { getPorcupineAccessKey } from '../voice/porcupineConfig';
import { BRAIN_MODELS } from '../ai/catalog';
import { getLlmService, type BenchResult } from '../ai/llm';
import {
  getModelManager,
  type DeviceGates,
  type ModelProgress,
  type ModelStatus,
} from '../ai/modelManager';

export interface SettingsScreenProps {
  audio: UseAudio;
  robot: UseRobot;
  onBack: () => void;
}

/**
 * Voice settings + wake-word test bench (no navigation lib needed: FaceScreen
 * swaps this in over the face). Test mode keeps Porcupine running and logs
 * every detection live; command turns are suppressed while testing.
 */
export default function SettingsScreen({ audio, robot, onBack }: SettingsScreenProps) {
  const [settings, setSettings] = useState<WakeSettings>(getWakeSettings());
  const [showDiag, setShowDiag] = useState(false);
  const keyOk = getPorcupineAccessKey() !== null;

  useEffect(() => onWakeSettings(setSettings), []);

  // Leaving the screen ends test mode so the normal pipeline resumes.
  useEffect(() => {
    return () => {
      if (audio.inTestMode) audio.setTestMode(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = (patch: Partial<WakeSettings>) => {
    setWakeSettings(patch);
    audio.applySettings(); // re-inits wake when safely idle, else deferred
  };

  if (showDiag) {
    return <DiagnosticsScreen robot={robot} audio={audio} onBack={() => setShowDiag(false)} />;
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backText}>‹ face</Text>
        </Pressable>
        <Text style={styles.title}>voice settings</Text>
      </View>
      <Pressable style={styles.testBtn} onPress={() => setShowDiag(true)}>
        <Text style={styles.testText}>open diagnostics</Text>
      </Pressable>

      <Text style={styles.section}>access key</Text>
      <Text style={[styles.note, keyOk ? styles.ok : styles.bad]}>
        {keyOk
          ? 'Picovoice key configured ✓'
          : 'Missing! Start with PICOVOICE_ACCESS_KEY=… (app.config.js).'}
      </Text>
      <Text style={styles.note}>
        .ppn files: assets/porcupine/hey-wii.ppn + hey-william.ppn (Android builds).
      </Text>

      <Text style={styles.section}>wake sensitivity</Text>
      <SliderRow
        label="Hey Wii"
        value={settings.sensitivityWii}
        onChange={(v) => apply({ sensitivityWii: v })}
      />
      <SliderRow
        label="Hey William"
        value={settings.sensitivityWilliam}
        onChange={(v) => apply({ sensitivityWilliam: v })}
      />
      <Text style={styles.note}>
        Higher = hears more (and false-triggers more). Start 0.5; drop to 0.3 if
        TV chatter wakes it; raise to 0.7 if it misses you across the room.
      </Text>

      <Text style={styles.section}>test wake word (live)</Text>
      <Pressable
        style={[styles.testBtn, audio.inTestMode && styles.testBtnActive]}
        onPress={() => audio.setTestMode(!audio.inTestMode)}
      >
        <Text style={styles.testText}>
          {audio.inTestMode ? 'stop test' : 'start test'}
        </Text>
      </Pressable>
      {!audio.running && !audio.inTestMode && (
        <Text style={styles.note}>Voice is off — start the test anyway; it opens the mic just for wake.</Text>
      )}
      <View style={styles.log}>
        {audio.detections.length === 0 ? (
          <Text style={styles.note}>
            {audio.inTestMode ? 'say “Hey Wii”…' : 'no detections yet'}
          </Text>
        ) : (
          audio.detections.slice(0, 8).map((d, i) => (
            <Text key={`${d.at}-${i}`} style={styles.logLine}>
              {new Date(d.at).toLocaleTimeString()} — {d.label}
            </Text>
          ))
        )}
      </View>
      {audio.lastHeard !== '' && (
        <Text style={styles.note}>last heard: “{audio.lastHeard}”</Text>
      )}

      <Text style={styles.section}>robot brain (on-device LLM)</Text>
      <BrainSection />
    </ScrollView>
  );
}

function SliderRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const widthRef = useRef(0);
  const setFromX = (x: number) => {
    if (widthRef.current <= 0) return;
    onChange(Math.max(0, Math.min(1, x / widthRef.current)));
  };
  return (
    <View style={styles.sliderWrap}>
      <Text style={styles.sliderLabel}>
        {label} {value.toFixed(2)}
      </Text>
      <View
        style={styles.track}
        onLayout={(e) => {
          widthRef.current = e.nativeEvent.layout.width;
        }}
        onStartShouldSetResponder={() => true}
        onResponderGrant={(e) => setFromX(e.nativeEvent.locationX)}
        onResponderMove={(e) => setFromX(e.nativeEvent.locationX)}
      >
        <View style={[styles.fill, { width: `${value * 100}%` as never }]} />
        <View style={[styles.thumb, { left: `${value * 100}%` as never }]} />
      </View>
    </View>
  );
}

function BrainSection() {
  const [modelId, setModelId] = useState(getModelManager().getSelected().id);
  const [status, setStatus] = useState<ModelStatus>('not_installed');
  const [gates, setGates] = useState<DeviceGates | null>(null);
  const [progress, setProgress] = useState<ModelProgress | null>(null);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    const mm = getModelManager();
    setModelId(mm.getSelected().id);
    setStatus(await mm.status());
    setGates(await mm.checkDevice());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const download = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await getModelManager().download((p) => setProgress(p));
      setProgress(null);
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const runBench = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const mm = getModelManager();
      const path = await mm.modelPath();
      if (!path) {
        setMsg('Model not installed.');
        return;
      }
      const r = await getLlmService().benchmark(path, mm.getSelected().stop);
      setBench(r);
    } catch (e) {
      setMsg(`Bench failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
  const mm = getModelManager();
  const selected = mm.getSelected();

  return (
    <View style={{ gap: 6 }}>
      {BRAIN_MODELS.map((m) => (
        <Pressable
          key={m.id}
          style={[styles.testBtn, modelId === m.id && styles.modelActive]}
          onPress={() => {
            mm.select(m.id);
            setBench(null);
            void refresh();
          }}
        >
          <Text style={styles.testText}>
            {m.label} · {m.quant} · ~{mb(m.sizeBytes)}
          </Text>
        </Pressable>
      ))}
      <Text style={styles.note}>
        status: {status}
        {status === 'ready' ? ' ✓' : ''}
        {gates && !gates.supported ? ` — ${gates.reason}` : ''}
      </Text>
      {progress && (
        <Text style={styles.note}>
          downloading {mb(progress.received)} / {mb(progress.total)}
        </Text>
      )}
      {msg && <Text style={styles.bad}>{msg}</Text>}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {status === 'downloading' || busy ? (
          <Pressable
            style={styles.testBtn}
            onPress={() => {
              void getModelManager().pause().then(() => refresh());
            }}
          >
            <Text style={styles.testText}>pause</Text>
          </Pressable>
        ) : (
          status !== 'ready' && (
            <Pressable style={styles.testBtn} onPress={download} disabled={busy}>
              <Text style={styles.testText}>download (~{mb(selected.sizeBytes)}, WiFi)</Text>
            </Pressable>
          )
        )}
        {status === 'ready' && (
          <>
            <Pressable style={styles.testBtn} onPress={runBench} disabled={busy}>
              <Text style={styles.testText}>benchmark tok/s</Text>
            </Pressable>
            <Pressable
              style={styles.testBtn}
              onPress={() => {
                void getModelManager().remove().then(() => refresh());
              }}
            >
              <Text style={styles.testText}>delete</Text>
            </Pressable>
          </>
        )}
      </View>
      {bench && (
        <Text style={styles.logLine}>
          {bench.tokens} tok · first token {bench.ttftMs} ms ·{' '}
          {bench.tokensPerSec.toFixed(1)} tok/s decode
        </Text>
      )}
      {getLlmService().isLoaded && <Text style={styles.note}>model resident in RAM (unloads after 3 min idle)</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#04060c' },
  content: { padding: 16, gap: 6, paddingBottom: 40 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  backBtn: { backgroundColor: '#1a2740', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  backText: { color: '#e9f2ff', fontSize: 14 },
  title: { color: '#e9f2ff', fontSize: 18, fontWeight: '700' },
  section: { color: '#9fb6d8', fontSize: 12, marginTop: 12, textTransform: 'uppercase' },
  note: { color: '#5b7192', fontSize: 12 },
  ok: { color: '#34d399' },
  bad: { color: '#ef4444' },
  testBtn: { backgroundColor: '#1a2740', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  testBtnActive: { backgroundColor: '#b91c1c' },
  testText: { color: '#e9f2ff', fontSize: 14, fontWeight: '600' },
  log: { backgroundColor: '#0a101c', borderRadius: 10, padding: 10, minHeight: 90, borderWidth: 1, borderColor: '#22314d' },
  logLine: { color: '#34d399', fontSize: 12 },
  modelActive: { borderWidth: 1, borderColor: '#2f5cb8' },
  sliderWrap: { gap: 6 },
  sliderLabel: { color: '#9fb6d8', fontSize: 12 },
  track: { height: 28, borderRadius: 8, backgroundColor: '#1a2740', overflow: 'hidden', justifyContent: 'center' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#2f5cb8' },
  thumb: { position: 'absolute', width: 4, top: 2, bottom: 2, marginLeft: -2, backgroundColor: '#e9f2ff', borderRadius: 2 },
});
