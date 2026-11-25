import React, {useEffect, useRef, useState} from 'react';
import type {MergePlanJournal} from './merge-plan-journal.js';
import type {MergePlan} from './merge-plan.js';
import {createMergePlanTestSummary, mergePlanTestText, type MergePlanTestResult} from './merge-plan-tests.js';

export function MergePlanTestView({document, locale, plan, journal, busy, run}: {
    document: Document;
    locale: string;
    plan: MergePlan;
    journal: MergePlanJournal;
    busy: boolean;
    run(signal: AbortSignal): Promise<MergePlanTestResult | undefined>;
}) {
    const text = mergePlanTestText(locale);
    const [result, setResult] = useState<MergePlanTestResult | null>();
    const [readError, setReadError] = useState(false);
    const [running, setRunning] = useState(false);
    const [stopped, setStopped] = useState(false);
    const summary = useRef<HTMLDivElement>(null);
    const controller = useRef<AbortController>();
    useEffect(() => {
        let active = true;
        void journal.testResult(plan).then(value => {
            if (active) setResult(value);
        }, () => {
            if (active) setReadError(true);
        });
        return () => {
            active = false;
            controller.current?.abort();
            controller.current = undefined;
        };
    }, [journal, plan]);
    useEffect(() => {
        if (result !== undefined) summary.current?.replaceChildren(createMergePlanTestSummary(document, locale, result));
    }, [document, locale, result]);

    return <div className="twgit-merge-tests">
        <button type="button" disabled={busy || result === undefined && !readError} onClick={async () => {
            if (controller.current) return;
            const current = controller.current = new AbortController();
            setRunning(true);
            setStopped(false);
            try {
                const fresh = await run(current.signal);
                if (controller.current === current && fresh) {
                    setResult(fresh);
                    setReadError(false);
                }
            } finally {
                if (controller.current === current) {
                    controller.current = undefined;
                    setRunning(false);
                    setStopped(current.signal.aborted);
                }
            }
        }}>{text.run}</button>
        {running && <button type="button" onClick={() => controller.current?.abort()}>{text.cancel}</button>}
        {running && <p role="status">{text.running}</p>}
        {stopped && <p role="status">{text.cancelled}</p>}
        {readError ? <p role="status">{text.unavailable}</p> :
            result === undefined && <p role="status">{text.loading}</p>}
        <div ref={summary}/>
    </div>;
}
