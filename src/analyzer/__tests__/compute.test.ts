import { describe, expect, it } from "vitest";
import { computeHighlights } from "../../analyzer/compute";
import type { RuntimeControls } from "../../analyzer/types";

// biome-ignore lint/suspicious/useAwait: test utility
async function alwaysResolve(): Promise<boolean> {
  return true;
}

type Case = {
  title: string;
  file: string;
  code: string;
  expectBody: number;
  expectIcon: number;
  expectCall: number;
  controls?: RuntimeControls;
};

const cases: Case[] = [
  {
    title: "local server function definition + await call + form action",
    file: "page.tsx",
    code: `
      export default async function Page() {
        async function onSubmit(formData: FormData) {
          'use server';
          return String(formData.get('title') ?? '');
        }
        const m = await onSubmit(new FormData());
        console.log(m);
        return (<form action={onSubmit} />);
      }
    `,
    expectBody: 1,
    expectIcon: 1,
    expectCall: 2,
  },
  {
    title: "top-level helpers are ignored (useEffect/useOptimistic/useRouter)",
    file: "helpers.tsx",
    code: `
      import { useEffect } from 'react';
      import { useOptimistic } from 'react';
      import { useRouter } from 'next/navigation';
      import { doThing } from './actions';
      export default function Comp(){
        useEffect(() => { doThing('x'); });
        const [s, setS] = useOptimistic(0 as number, (s, _d) => s);
        const r = useRouter();
        r.push('/');
        return null;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    // Only the inner doThing call should be considered (helpers themselves ignored)
    expectCall: 1,
  },
  {
    title: "module prologue + exported async function",
    file: "mod-prologue.tsx",
    code: `
      'use server';
      export async function doIt() { return 1; }
      export default function P(){
        doIt();
        return (<form action={doIt}><button>go</button></form>);
      }
    `,
    expectBody: 1,
    expectIcon: 1,
    expectCall: 2,
  },
  {
    title: "local const async arrow with 'use server' + direct call",
    file: "local-const.tsx",
    code: `
      export default function P(){
        const run = async () => { 'use server'; return 1; };
        run();
        return null;
      }
    `,
    expectBody: 1,
    expectIcon: 1,
    expectCall: 1,
  },
  {
    title: "optional chaining property call (obj?.run?.()) is not highlighted",
    file: "opt-chain.tsx",
    code: `
      export default function P(){
        const obj: any = { run: () => {} };
        obj?.run?.();
        return null;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 0,
  },
  {
    title: "direct call through nested wrappers is detected",
    file: "wrap.ts",
    code: `
      export default function P(){
        const id = () => {};
        (((id as any))!)();
        return null;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 1,
  },
  {
    title: "type-only import is excluded from call highlight",
    file: "types-only.ts",
    code: `
      import type { foo } from './x';
      export default function P(){ foo(); return null; }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 0,
  },
  {
    title: "startTransition detects property access callee",
    file: "st-prop.tsx",
    code: `
      export default function P(){
        const run = () => {};
        const api = { run: () => {} } as any;
        startTransition(() => api.run());
        return null;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 1,
  },
  {
    title: "element access call is not supported (no highlight)",
    file: "elem.ts",
    code: `
      const obj: any = { run: () => {} };
      export default function P(){ obj['run'](); return null; }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 0,
  },
  {
    title: "namespace import call is highlighted (ns.fn())",
    file: "ns.ts",
    code: `
      import * as actions from './a';
      export default function P(){ actions.submit(); return null; }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 1,
  },
  {
    title:
      "namespace import multi-level property is not highlighted (ns.group.fn())",
    file: "ns2.ts",
    code: `
      import * as actions from './a';
      export default function P(){ actions.group.submit(); return null; }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 0,
  },
  {
    title: "async export without 'use server' is not a definition",
    file: "no-server.ts",
    code: `
      export async function maybeAction() { return 1 }
      export default async function Page(){
        await maybeAction();
        return null;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    // The call itself is a local callable and resolve returns true, so it becomes 1 item.
    expectCall: 1,
  },
  {
    title: "global builtins (alert/console) are excluded",
    file: "builtin.tsx",
    code: `
      export default function Comp(){
        alert('hello');
        console.log('noop');
        return null;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 0,
  },
  {
    title: "non-async function with 'use server' is not a definition",
    file: "not-action.ts",
    code: `
      export function notAction(){ 'use server'; return 1; }
      export default function Page(){ notAction(); return null; }
    `,
    expectBody: 0,
    expectIcon: 0,
    // The call would not resolve either (even with alwaysResolve, it might become 1 because pre-filter won't exclude it),
    // but since it's considered an imported/local callable, there will be one direct call.
    // We don't expect 0 here; this case only verifies definitions.
    expectCall: 1,
  },
  {
    title: "builder/factory definition + direct call + form action",
    file: "builder.tsx",
    code: `
      'use server';
      import { actionClient } from './safe-action';
      export const greetAction = actionClient
        .inputSchema({})
        .action(async (name: string) => {
          return 'hi ' + name;
        });
      async function Page(){
        const v = await greetAction('you');
        return (<form action={greetAction}><button>go</button></form>);
      }
    `,
    expectBody: 1,
    expectIcon: 1,
    expectCall: 2,
  },
  {
    title: "JSX inline server function definition + jsx call",
    file: "inline.tsx",
    code: `
      export default function Page(){
        return (
          <form action={async () => { 'use server'; console.log('inlined'); }}>
            <button>send</button>
          </form>
        );
      }
    `,
    expectBody: 1,
    expectIcon: 1,
    expectCall: 1,
  },
  {
    title: "imported server function call (no local definitions)",
    file: "admin.tsx",
    code: `
      import { adminAction } from './action';
      export default async function AdminPage(){
        const data = await adminAction();
        return <div>{String(data)}</div>;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 1,
  },
  {
    title: "startTransition + useActionState patterns",
    file: "comp.tsx",
    code: `
      import { someAction } from './actions';
      export default function Comp(){
        startTransition(() => someAction('x'));
        const [s, doAction] = useActionState(someAction, null);
        return <button onClick={() => doAction('y')}>Run</button>;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 2,
  },
  {
    title: "useTransition startTransition callback highlights server functions",
    file: "use-transition.tsx",
    code: `
      import { useTransition } from 'react';
      import { doThing } from './actions';
      export default function Comp(){
        const [isPending, startTransition] = useTransition();
        startTransition(() => doThing('z'));
        return <span>{String(isPending)}</span>;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 1,
  },
  {
    title:
      "useTransition async startTransition callback highlights server functions",
    file: "use-transition-async.tsx",
    code: `
      import { useTransition } from 'react';
      import { doThing } from './actions';
      export default function Comp(){
        const [isPending, startTransition] = useTransition();
        startTransition(async () => {
          await doThing('z');
        });
        return <span>{String(isPending)}</span>;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 1,
  },
  {
    title: "ignoreCallees excludes imported call",
    file: "ignore-import.tsx",
    code: `
      import { doThing } from './actions';
      export default function C(){
        doThing('x');
        return null;
      }
    `,
    expectBody: 0,
    expectIcon: 0,
    expectCall: 0,
    controls: { ignoreCallees: ["doThing"] },
  },
  {
    title: "ignoreCallees excludes local callable call",
    file: "ignore-local.tsx",
    code: `
      export default function P(){
        async function doThing(){ 'use server'; return 1; }
        doThing();
        return null;
      }
    `,
    expectBody: 1,
    expectIcon: 1,
    expectCall: 0,
    controls: { ignoreCallees: ["doThing"] },
  },
];

describe("highlight/computeHighlights (parameterized)", () => {
  it.each(cases)(
    "$title",
    async ({ code, file, expectBody, expectIcon, expectCall, controls }) => {
      const res = await computeHighlights(
        code,
        file,
        `file:///${file}`,
        alwaysResolve,
        controls
      );
      expect(res.bodyRanges.length).toBe(expectBody);
      expect(res.iconRanges.length).toBe(expectIcon);
      expect(res.callRanges.length).toBe(expectCall);
    }
  );
});
