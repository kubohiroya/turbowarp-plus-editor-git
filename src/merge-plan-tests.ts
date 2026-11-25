import type {MergePlan, MergePlanFiles} from './merge-plan.js';

type TestStatus = 'passed' | 'failed' | 'timed-out' | 'error';
type Counts = Record<TestStatus, number>;

/** The relevant parts of the Editor test runner's report. */
interface RunnerReport {
    counts: Counts;
    results: ReadonlyArray<{name: string; target: string; blockId: string; status: TestStatus; message?: string;
        assertions: readonly {passed: boolean; blockId: string | null; kind: string; message?: string}[]}>;
}

export type RunMergePlanTests = (files: MergePlanFiles, signal: AbortSignal) => Promise<RunnerReport>;

export interface MergePlanTestResult {
    runId?: string;
    planId?: string;
    generationId: string;
    contentId: string;
    finishedAt: number;
    counts: Counts;
    total: number;
    tests: ReadonlyArray<{name: string; target: string; blockId: string; status: TestStatus; message?: string;
        failures: readonly string[]; failureCount: number}>;
    error?: string;
    cancelled?: boolean;
}

const emptyCounts = (): Counts => ({passed: 0, failed: 0, 'timed-out': 0, error: 0});
const shortText = (value: string) => value.slice(0, 512);

export function mergePlanTestResult(plan: MergePlan, report?: RunnerReport, error?: string, cancelled = false): MergePlanTestResult {
    return {
        runId: crypto.randomUUID(),
        planId: plan.planId,
        generationId: plan.id,
        contentId: plan.contentId,
        finishedAt: Date.now(),
        counts: report?.counts ?? emptyCounts(),
        total: report?.results.length ?? 0,
        tests: report?.results.map(({name, target, blockId, status, message, assertions}) => {
            const failed = assertions.filter(assertion => !assertion.passed);
            return {name: shortText(name), target: shortText(target), blockId, status, message: message && shortText(message),
                failureCount: failed.length,
                failures: failed.slice(0, 10).map(({kind, blockId, message}) =>
                    [kind, blockId, message && shortText(message)].filter(Boolean).join(' · '))};
        }) ?? [],
        ...(error !== undefined && {error: shortText(error)}),
        ...(cancelled && {cancelled: true})
    };
}

export const mergePlanTestText = (locale: string) => locale.startsWith('ja') ? {
    title: '世代のテスト結果', run: 'この世代のテストを実行', cancel: 'テストを中止', cancelled: 'テストを中止しました。',
    running: '保存世代をテスト中…', loading: 'テスト結果を読み込み中…', unavailable: '保存したテスト結果を読み込めませんでした。',
    missing: 'この世代のテストは未実行です。', empty: 'この世代にテストはありません。', error: 'テストを実行できませんでした。',
    counts: (result: Counts) => `成功 ${result.passed} · 失敗 ${result.failed} · 時間切れ ${result['timed-out']} · エラー ${result.error}`,
    status: {passed: '成功', failed: '失敗', 'timed-out': '時間切れ', error: 'エラー'},
    failedChecks: (count: number) => `失敗したチェック ${count} 件`, details: 'テストの詳細', history: '以前の実行結果'
} : {
    title: 'Generation test results', run: 'Run tests for this generation', cancel: 'Stop tests', cancelled: 'Test run stopped.',
    running: 'Testing the saved generation…', loading: 'Reading test results…', unavailable: 'Could not read the saved test results.',
    missing: 'No tests have been run for this generation.', empty: 'This generation has no tests.', error: 'The test run could not complete.',
    counts: (result: Counts) => `Passed ${result.passed} · Failed ${result.failed} · Timed out ${result['timed-out']} · Errors ${result.error}`,
    status: {passed: 'Passed', failed: 'Failed', 'timed-out': 'Timed out', error: 'Error'},
    failedChecks: (count: number) => `Failed checks: ${count}`, details: 'Test details', history: 'Earlier test runs'
};

export function createMergePlanTestSummary(document: Document, locale: string, result: MergePlanTestResult | null) {
    const text = mergePlanTestText(locale);
    const section = document.createElement('section');
    section.setAttribute('aria-label', text.title);
    const heading = document.createElement('h3');
    heading.textContent = text.title;
    const summary = document.createElement('p');
    summary.textContent = result === null ? text.missing : result.cancelled ? text.cancelled : result.error !== undefined ? text.error :
        result.total ? text.counts(result.counts) : text.empty;
    section.append(heading, summary);
    if (!result) return section;
    const date = document.createElement('time');
    date.dateTime = new Date(result.finishedAt).toISOString();
    date.textContent = new Date(result.finishedAt).toLocaleString(locale);
    section.append(date);
    if (result.error) {
        const reason = document.createElement('p');
        reason.textContent = result.error;
        section.append(reason);
    }
    if (result.tests.length) {
        const details = document.createElement('details');
        const toggle = document.createElement('summary');
        toggle.textContent = text.details;
        const list = document.createElement('ul');
        for (const test of result.tests) {
            const row = document.createElement('li');
            row.textContent = [test.name, test.target, text.status[test.status], test.message,
                test.failureCount && text.failedChecks(test.failureCount)].filter(Boolean).join(' · ');
            if (test.failures.length) {
                const checks = document.createElement('ul');
                for (const failure of test.failures) {
                    const check = document.createElement('li');
                    check.textContent = failure;
                    checks.append(check);
                }
                row.append(checks);
            }
            list.append(row);
        }
        details.append(toggle, list);
        section.append(details);
    }
    return section;
}
