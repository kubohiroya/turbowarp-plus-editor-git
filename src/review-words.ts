import type {ScriptSummaryItem} from './project-source-review-model.js';

type Pair = readonly [string, string];
const pick = ([ja, en]: Pair, locale: string) => locale.startsWith('ja') ? ja : en;

// Hat blocks name a script, as people read it in the Editor.
const hats = new Map<string, Pair>([
    ['event_whenflagclicked', ['緑の旗が押されたとき', 'When green flag clicked']],
    ['event_whenthisspriteclicked', ['このスプライトが押されたとき', 'When this sprite clicked']],
    ['event_whenstageclicked', ['ステージが押されたとき', 'When stage clicked']],
    ['event_whenkeypressed', ['キーが押されたとき', 'When key pressed']],
    ['event_whenbackdropswitchesto', ['背景が切り替わったとき', 'When backdrop switches']],
    ['event_whengreaterthan', ['値が超えたとき', 'When value exceeds']],
    ['event_whenbroadcastreceived', ['メッセージを受け取ったとき', 'When message received']],
    ['control_start_as_clone', ['クローンされたとき', 'When I start as a clone']],
    ['procedures_definition', ['定義', 'Define']]
]);

// Only blocks that summaries name; anything else is called a block.
const blocks = new Map<string, Pair>([
    ['control_repeat', ['〜回繰り返す', 'repeat'], ], ['control_forever', ['ずっと', 'forever']],
    ['control_repeat_until', ['〜まで繰り返す', 'repeat until']], ['control_while', ['〜の間繰り返す', 'while']],
    ['control_if', ['もし〜なら', 'if']], ['control_if_else', ['もし〜なら、でなければ', 'if else']],
    ['control_wait', ['〜秒待つ', 'wait']], ['motion_movesteps', ['〜歩動かす', 'move steps']],
    ['motion_turnright', ['〜度回す', 'turn']], ['motion_turnleft', ['〜度回す', 'turn']], ['motion_gotoxy', ['x座標を〜、y座標を〜にする', 'go to x y']],
    ['motion_changeyby', ['y座標を〜ずつ変える', 'change y by']], ['motion_changexby', ['x座標を〜ずつ変える', 'change x by']],
    ['motion_glidesecstoxy', ['〜秒でx座標を〜に、y座標を〜に変える', 'glide']],
    ['looks_sayforsecs', ['〜と〜秒言う', 'say for secs']], ['looks_say', ['〜と言う', 'say']],
    ['looks_switchcostumeto', ['コスチュームを〜にする', 'switch costume']], ['looks_nextcostume', ['次のコスチュームにする', 'next costume']],
    ['data_setvariableto', ['〜を〜にする', 'set variable']], ['data_changevariableby', ['〜を〜ずつ変える', 'change variable']],
    ['event_broadcast', ['〜を送る', 'broadcast']], ['sound_play', ['〜の音を鳴らす', 'play sound']]
]);

export function hatName(opcode: string, locale: string): string | undefined {
    const pair = hats.get(opcode);
    return pair && pick(pair, locale);
}

const blockName = (opcode: string, locale: string) => {
    const pair = blocks.get(opcode) ?? hats.get(opcode);
    return pair ? pick(pair, locale) : locale.startsWith('ja') ? 'ブロック' : 'a block';
};

/** One phrase per summary item, in the reader's language. */
export function summaryPhrase(item: ScriptSummaryItem, locale: string): string {
    const ja = locale.startsWith('ja');
    switch (item.kind) {
    case 'hatReplaced': return ja ? `「${blockName(item.before, locale)}」を「${blockName(item.after, locale)}」に替えた` :
        `replaced “${blockName(item.before, locale)}” with “${blockName(item.after, locale)}”`;
    case 'wrapped': return ja ? `「${blockName(item.opcode, locale)}」で包んだ` : `wrapped in “${blockName(item.opcode, locale)}”`;
    case 'branchAdded': return ja ? `分岐「${blockName(item.opcode, locale)}」を追加` : `added “${blockName(item.opcode, locale)}”`;
    case 'valueChanged':
        if (item.values && item.opcode === 'motion_movesteps' && item.name === 'STEPS') {
            const {before, after} = item.values;
            return ja ? `移動する歩数を ${before} → ${after} に変更` : `Changed the number of steps from ${before} to ${after}`;
        }
        return ja ? `「${blockName(item.opcode, locale)}」の ${item.name} を変更` :
            `changed ${item.name} of “${blockName(item.opcode, locale)}”`;
    case 'blocksAdded': return ja ? `ブロックを ${item.count} 個追加` : `added ${item.count} ${item.count === 1 ? 'block' : 'blocks'}`;
    case 'blocksRemoved': return ja ? `ブロックを ${item.count} 個削除` : `removed ${item.count} ${item.count === 1 ? 'block' : 'blocks'}`;
    case 'reordered': return ja ? 'つなぎ方だけを変更' : 'only reconnected';
    case 'moved': return ja ? '位置だけを変更' : 'only moved';
    }
}

/** The colours of the previews, said once at the top of a review. */
export const legend = (locale: string) => locale.startsWith('ja') ?
    [['added', '緑の縁: 追加したブロック'], ['removed', '赤の縁: 削除したブロック'], ['updated', '紫の縁: 中身を変えたブロック'],
        ['part', 'オレンジの枠: 値を変えた欄']] as const :
    [['added', 'Green outline: added block'], ['removed', 'Red outline: removed block'], ['updated', 'Purple outline: block with changed contents'],
        ['part', 'Orange frame: changed value']] as const;
