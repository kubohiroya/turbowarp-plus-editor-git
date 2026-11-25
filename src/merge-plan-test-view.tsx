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
    const [history, setHistory] = useState<{id: string; results: MergePlanTestResult[]}>();
    const [change, setChange] = useState(0);
    const [readError, setReadError] = useState(false);
    const [running, setRunning] = useState<string>();
    const summary = useRef<HTMLDivElement>(null);
    const controller = useRef<AbortController>();
    useEffect(() => {
        return () => {
            controller.current?.abort();
            controller.current = undefined;
        };
    }, []);
    useEffect(() => {
        let active = true;
        setReadError(false);
        void journal.testHistory(plan).then(results => {
            if (active) setHistory({id: plan.id, results});
        }, () => {
            if (active) setReadError(true);
        });
        return () => {active = false;};
    }, [journal, plan, change]);
    const results = history?.id === plan.id ? history.results : undefined;
    useEffect(() => {
        const [latest, ...previous] = results ?? [];
        const elements: HTMLElement[] = results ? [createMergePlanTestSummary(document, locale, latest ?? null)] : [];
        if (previous.length) {
            const history = document.createElement('details');
            const label = document.createElement('summary');
            label.textContent = text.history;
            history.append(label, ...previous.map(result => createMergePlanTestSummary(document, locale, result)));
            elements.push(history);
        }
        summary.current?.replaceChildren(...elements);
    }, [document, locale, results, text.history]);

    return <div className="twgit-merge-tests">
        <button type="button" disabled={busy || !!running || results === undefined && !readError} onClick={async () => {
            if (controller.current) return;
            const current = controller.current = new AbortController();
            setRunning(plan.id);
            try {
                const fresh = await run(current.signal);
                if (controller.current === current && fresh) {
                    setChange(value => value + 1);
                    setReadError(false);
                }
            } finally {
                if (controller.current === current) {
                    controller.current = undefined;
                    setRunning(undefined);
                }
            }
        }}>{text.run}</button>
        {running && <button type="button" onClick={() => controller.current?.abort()}>{text.cancel}</button>}
        {running === plan.id && <p role="status">{text.running}</p>}
        {readError ? <p role="status">{text.unavailable}</p> :
            results === undefined && <p role="status">{text.loading}</p>}
        <div ref={summary}/>
    </div>;
}
