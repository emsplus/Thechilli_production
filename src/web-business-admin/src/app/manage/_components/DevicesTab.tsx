"use client";

import { PillTabs } from "@/components/ui";
import { AllDevices } from "@/components/devices/AllDevices";
import { CounterDevices } from "@/components/devices/CounterDevices";
import { MyDevices } from "@/components/devices/MyDevices";
import { may, PERM_DEVICES } from "@/lib/devices";
import { useManage } from "./manage-context";

export type DevicesView = "mine" | "staff" | "counter";

/**
 * Manage > Devices (pos-service docs/STAFF_PIN_DEVICES_API.md). Everyone: their own signed-in devices. devices.manage:
 * everyone's devices (filter by person) and the shared counter tablets. Without the permission only "My devices" exists.
 */
export function DevicesTab({ view, onView }: { view?: string; onView: (v: DevicesView) => void }) {
  const { me } = useManage();
  const admin = may(me, PERM_DEVICES);
  const current: DevicesView = admin && (view === "staff" || view === "counter") ? view : "mine";
  return (
    <div className="space-y-5" data-testid="devices-tab">
      {admin && (
        <PillTabs label="Devices sections" value={current} onChange={onView}
          options={[{ value: "mine", label: "My devices" }, { value: "staff", label: "All staff devices" }, { value: "counter", label: "Counter devices" }]} />
      )}
      {current === "mine" && <MyDevices me={me} />}
      {current === "staff" && <AllDevices me={me} />}
      {current === "counter" && <CounterDevices readOnly={!!me.read_only} />}
    </div>
  );
}
