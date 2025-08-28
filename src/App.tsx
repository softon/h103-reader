import React, { useEffect, useMemo, useRef, useState } from "react";
import { Download, Bluetooth, Keyboard, Trash2, Pause, Play, Settings } from "lucide-react";
import './index.css'   // 👈 Tailwind included here

// Utility: text encoder/decoder
const te = new TextEncoder();
const td = new TextDecoder();

// Default (editable) UUIDs — leave as-is if unknown.
// Many BLE UART-like modules use one of these; H103 may expose vendor UUIDs.
// You can edit these at runtime in the UI.
const PRESETS = [
  { name: "Nordic UART (NUS)", service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e", rx: "6e400003-b5a3-f393-e0a9-e50e24dcca9e", tx: "6e400002-b5a3-f393-e0a9-e50e24dcca9e" },
  { name: "TI/Feasycom FFE0/FFE1", service: "0000ffe0-0000-1000-8000-00805f9b34fb", rx: "0000ffe1-0000-1000-8000-00805f9b34fb", tx: "0000ffe1-0000-1000-8000-00805f9b34fb" },
  { name: "Custom (edit below)", service: "", rx: "", tx: "" },
];

export default function App() {
  const [mode, setMode] = useState<'hid' | 'ble'>("hid");
  const [connected, setConnected] = useState(false);
  const [listening, setListening] = useState(true);
  const [deviceName, setDeviceName] = useState<string>("");
  const [tags, setTags] = useState<{ id: number; epc: string; rssi?: number; ts: number }[]>([]);
  const [buffer, setBuffer] = useState<string>("");
  const [sep, setSep] = useState<string>("\n");
  const [autoDedup, setAutoDedup] = useState(true);

  // BLE state
  const [svcUUID, setSvcUUID] = useState<string>(PRESETS[0].service);
  const [rxUUID, setRxUUID] = useState<string>(PRESETS[0].rx);
  const [txUUID, setTxUUID] = useState<string>(PRESETS[0].tx);
  const bleDeviceRef = useRef<BluetoothDevice | null>(null);
  const bleCharRxRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const bleCharTxRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);

  // HID keyboard wedge input
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the wedge input in HID mode
  useEffect(() => {
    if (mode === "hid") {
      const t = setTimeout(() => inputRef.current?.focus(), 300);
      return () => clearTimeout(t);
    }
  }, [mode]);

  const addTag = (epcRaw: string, rssi?: number) => {
    const epc = epcRaw.trim();
    if (!epc) return;
    setTags((prev) => {
      if (autoDedup && prev.some((t) => t.epc === epc)) return prev;
      return [{ id: Date.now() + Math.random(), epc, rssi, ts: Date.now() }, ...prev].slice(0, 2000);
    });
  };

  const handleLine = (line: string) => {
    if (!listening) return;
    // Simple EPC filter: allow hex-ish strings, but don’t be too strict.
    const cleaned = line.replace(/[^0-9a-zA-Z\-_:]/g, "");
    if (cleaned) addTag(cleaned);
  };

  // HID wedge handling — tags come as keystrokes ending in Enter
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!listening) return;
    if (e.key === "Enter") {
      handleLine(buffer);
      setBuffer("");
    } else if (e.key.length === 1) {
      setBuffer((b) => b + e.key);
    } else if (e.key === "Backspace") {
      setBuffer((b) => b.slice(0, -1));
    }
  };

  // BLE connect and subscribe (Chafon H103 logic)
  const connectBLE = async () => {
    // Chafon H103 UUIDs (from index.html)
    const SERVICE_UUID     = "0000ffe0-0000-1000-8000-00805f9b34fb";
    const WRITE_CHAR_UUID  = "0000ffe3-0000-1000-8000-00805f9b34fb";
    const NOTIFY_CHAR_UUID = "0000ffe4-0000-1000-8000-00805f9b34fb";

    if (!(navigator as any).bluetooth) {
      alert("Web Bluetooth not supported in this browser.");
      return;
    }
    try {
      setDeviceName("");
      const device = await (navigator as any).bluetooth.requestDevice({
        //filters: [{ services: [SERVICE_UUID] }]
        acceptAllDevices: true,
          optionalServices: [SERVICE_UUID]
      });
      bleDeviceRef.current = device;
      setDeviceName(device.name || "Unnamed device");

      device.addEventListener("gattserverdisconnected", () => {
        setConnected(false);
      });

      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const writeChar = await service.getCharacteristic(WRITE_CHAR_UUID);
      bleCharTxRef.current = writeChar;
      const notifyChar = await service.getCharacteristic(NOTIFY_CHAR_UUID);
      bleCharRxRef.current = notifyChar;
      await notifyChar.startNotifications();

      notifyChar.addEventListener("characteristicvaluechanged", (event: any) => {
        const value = event.target.value;
        if (!value) return;
        const data = new Uint8Array(value.buffer);
        // Find EPC start (0xE2)
        const idx = data.indexOf(0xE2);
        if (idx !== -1) {
          const epcBytes = data.slice(idx, idx + 12); // 96-bit EPC
          const epc = Array.from(epcBytes)
            .map(b => b.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase();
          addTag(epc);
        }
      });

      setConnected(true);
      alert("Connected. Scan tags to see EPCs (unique only).\nIf you see nothing, ensure your H103 is in BLE mode and using the correct UUIDs.");
      // Optionally: send start inventory command here using writeChar.writeValue()
    } catch (err: any) {
      console.error(err);
      alert(`BLE connect failed: ${err?.message || err}`);
    }
  };

  const disconnectBLE = async () => {
    try {
      bleCharRxRef.current?.removeEventListener("characteristicvaluechanged", () => {});
      if (bleDeviceRef.current?.gatt?.connected) bleDeviceRef.current.gatt.disconnect();
    } catch {}
    setConnected(false);
  };

  const clearTags = () => setTags([]);

  const exportCSV = () => {
    const rows = ["epc,rssi,timestamp", ...tags.map((t) => `${t.epc},${t.rssi ?? ""},${new Date(t.ts).toISOString()}`)];
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tags_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const onPreset = (idx: number) => {
    const p = PRESETS[idx];
    setSvcUUID(p.service);
    setRxUUID(p.rx);
    setTxUUID(p.tx);
  };

  const statusChip = useMemo(() => {
    if (mode === 'hid') return <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-700 text-xs">HID Wedge</span>;
    return connected ? (
      <span className="px-2 py-1 rounded-full bg-green-100 text-green-800 text-xs">BLE Connected</span>
    ) : (
      <span className="px-2 py-1 rounded-full bg-yellow-100 text-yellow-800 text-xs">BLE Disconnected</span>
    );
  }, [mode, connected]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Chafon H103 – Web Tag Reader</h1>
            <p className="text-sm text-slate-600">Use HID (keyboard wedge) or Web Bluetooth (custom GATT) to capture EPCs in the browser.</p>
          </div>
          <div className="flex items-center gap-3">{statusChip}
            <button className="px-3 py-2 rounded-2xl shadow-sm bg-white border hover:bg-slate-50" onClick={exportCSV} title="Export CSV">
              <Download className="w-4 h-4" />
            </button>
            <button className="px-3 py-2 rounded-2xl shadow-sm bg-white border hover:bg-slate-50" onClick={clearTags} title="Clear Tags">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Mode Switch */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="p-4 rounded-2xl bg-white shadow-sm border">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-medium flex items-center gap-2"><Keyboard className="w-4 h-4"/>Input Mode</h2>
              <span className="text-xs text-slate-500">(You can switch any time)</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setMode('hid')}
                className={`px-3 py-2 rounded-xl border ${mode==='hid' ? 'bg-slate-900 text-white' : 'bg-white hover:bg-slate-50'}`}
              >HID Wedge</button>
              <button
                onClick={() => setMode('ble')}
                className={`px-3 py-2 rounded-xl border ${mode==='ble' ? 'bg-slate-900 text-white' : 'bg-white hover:bg-slate-50'}`}
              >Web Bluetooth</button>
              <button
                onClick={() => setListening(v=>!v)}
                className="ml-auto px-3 py-2 rounded-xl border bg-white hover:bg-slate-50 flex items-center gap-2"
                title={listening? 'Pause capture' : 'Resume capture'}
              >{listening ? <Pause className="w-4 h-4"/> : <Play className="w-4 h-4"/>}{listening? 'Pause' : 'Resume'}</button>
            </div>

            {mode === 'hid' ? (
              <div className="mt-4">
                <p className="text-sm text-slate-600 mb-2">Put your H103 in <b>HID keyboard</b> (wedge) mode. Click the box below to focus, then pull the trigger to scan tags. Each scan ending in Enter will be recorded as one line.</p>
                <div className="p-4 rounded-xl bg-slate-50 border">
                  <label className="text-xs text-slate-500">Live keystrokes buffer (press Enter to commit)</label>
                  <input
                    ref={inputRef}
                    value={buffer}
                    onChange={()=>{}}
                    onKeyDown={onKeyDown}
                    className="mt-1 w-full rounded-lg border px-3 py-2 focus:outline-none focus:ring"
                    placeholder="Focus here and scan…"
                  />
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-slate-600">Connect via Web Bluetooth to a custom UART-like service. If you don’t know the UUIDs, try presets or contact Chafon for H103 GATT docs. RX should support <i>notify</i>; TX is optional for commands.</p>
                <div className="grid md:grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs text-slate-500 flex items-center gap-1"><Settings className="w-3 h-3"/>Service UUID</label>
                    <input value={svcUUID} onChange={e=>setSvcUUID(e.target.value)} className="w-full border rounded-lg px-3 py-2" placeholder="e.g. 6e400001-…"/>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500">RX (Notify) UUID</label>
                    <input value={rxUUID} onChange={e=>setRxUUID(e.target.value)} className="w-full border rounded-lg px-3 py-2" placeholder="e.g. 6e400003-…"/>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500">TX (Write) UUID</label>
                    <input value={txUUID} onChange={e=>setTxUUID(e.target.value)} className="w-full border rounded-lg px-3 py-2" placeholder="e.g. 6e400002-…"/>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <select onChange={(e)=>onPreset(Number(e.target.value))} className="border rounded-lg px-3 py-2">
                    {PRESETS.map((p, i) => (<option value={i} key={p.name}>{p.name}</option>))}
                  </select>
                  <button onClick={connected? disconnectBLE : connectBLE} className="px-3 py-2 rounded-xl border bg-white hover:bg-slate-50 flex items-center gap-2">
                    <Bluetooth className="w-4 h-4"/>{connected? 'Disconnect' : 'Connect'}</button>
                  <span className="text-sm text-slate-500">{deviceName}</span>
                </div>
                <div>
                  <label className="text-xs text-slate-500">Record separator (used to split incoming text)</label>
                  <input value={sep} onChange={(e)=>setSep(e.target.value)} className="w-full border rounded-lg px-3 py-2"/>
                </div>
              </div>
            )}
          </div>

          {/* Live Tags */}
          <div className="p-4 rounded-2xl bg-white shadow-sm border">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-medium">Live Tags</h2>
              <div className="text-sm text-slate-500">{tags.length} captured</div>
            </div>
            <div className="overflow-auto max-h-[60vh] border rounded-xl">
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 bg-slate-50">
                  <tr>
                    <th className="text-left px-3 py-2 border-b">#</th>
                    <th className="text-left px-3 py-2 border-b">EPC / Data</th>
                    <th className="text-left px-3 py-2 border-b">RSSI</th>
                    <th className="text-left px-3 py-2 border-b">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {tags.map((t, i) => (
                    <tr key={t.id} className="odd:bg-white even:bg-slate-50/40">
                      <td className="px-3 py-2 border-b">{tags.length - i}</td>
                      <td className="px-3 py-2 border-b font-mono">{t.epc}</td>
                      <td className="px-3 py-2 border-b">{t.rssi ?? ''}</td>
                      <td className="px-3 py-2 border-b text-slate-500">{new Date(t.ts).toLocaleString()}</td>
                    </tr>
                  ))}
                  {tags.length === 0 && (
                    <tr>
                      <td className="px-3 py-6 text-center text-slate-500" colSpan={4}>No tags yet. {mode==='hid' ? 'Focus the input and scan.' : 'Connect over BLE and start scanning.'}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between mt-3">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={autoDedup} onChange={(e)=>setAutoDedup(e.target.checked)} />
                Deduplicate EPCs
              </label>
              <div className="text-xs text-slate-500">Tip: Export CSV for analysis</div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <p className="text-xs text-slate-500 text-center">Browser requirements: Chrome/Edge on desktop for Web Bluetooth. HID wedge works in any modern browser by capturing keystrokes. For true BLE, you MUST supply the correct service and characteristic UUIDs from Chafon H103 docs/SDK.</p>
      </div>
    </div>
  );
}
