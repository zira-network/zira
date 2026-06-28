// apps/web/src/app/Styleguide.tsx
// Shows every primitive, the Meter at several values, ZiraMark, and HexField.
import { Card, Button, Input, Textarea, Select, Badge, Meter, Spinner } from "../components/ui";
import { ZiraMark, HexField } from "../components/brand";

export function Styleguide() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <Card>
        <h3 className="mb-3 text-sm font-semibold">Brand</h3>
        <div className="flex items-center gap-6">
          <ZiraMark size={48} glow />
          <HexField size={100} />
        </div>
      </Card>
      <Card>
        <h3 className="mb-3 text-sm font-semibold">Buttons</h3>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
        </div>
      </Card>
      <Card>
        <h3 className="mb-3 text-sm font-semibold">Inputs</h3>
        <div className="space-y-2">
          <Input placeholder="Input" />
          <Textarea placeholder="Textarea" />
          <Select><option>Select</option></Select>
        </div>
      </Card>
      <Card>
        <h3 className="mb-3 text-sm font-semibold">Badges</h3>
        <div className="flex flex-wrap gap-2">
          <Badge tone="teal">teal</Badge><Badge tone="indigo">indigo</Badge>
          <Badge tone="warn">warn</Badge><Badge tone="danger">danger</Badge><Badge tone="neutral">neutral</Badge>
        </div>
      </Card>
      <Card>
        <h3 className="mb-3 text-sm font-semibold">Meter (trust gradient)</h3>
        <div className="space-y-2">
          {[0.05, 0.25, 0.5, 0.7, 0.95].map((v) => <Meter key={v} value={v} label={`ZTI ${v}`} />)}
        </div>
      </Card>
      <Card>
        <h3 className="mb-3 text-sm font-semibold">Spinner</h3>
        <Spinner size={28} />
      </Card>
    </div>
  );
}
