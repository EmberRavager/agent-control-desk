/** Deliberately narrow: only a single factual field can be answered unattended. */
type Field = "city" | "language" | "timezone";

const sensitive =
  /授权|批准|同意|允许|执行命令|转账|删除|覆盖|上传|发送给|密码|凭证|令牌|approve|allow|permission|delete|upload|password|token/i;
const conditional =
  /不要|不是|别查|不确定|如果|假设|例如|比如|可能|或者|还是|并非|上次|之前|以前|曾经|改为|改查|换成|分别|同时|对比|比较|not |maybe|perhaps/i;
const relativePlace =
  /我|你|他|家|公司|办公室|学校|单位|目的地|出发地|所在地|位置|未知|这里|那里|附近|这边|那边|本地|当地|本市|市区|当前|用户|默认|所在|出差|旅行|上次|两个|其他|以及|分别|比较|和|与|或|查|问|天气|需要|想知|看|了解|告诉|请|here|home|office|destination|local|current|nearby/i;

function fieldOf(question: string): Field | undefined {
  if (sensitive.test(question) || question.length > 350) return;
  const sentences = question
    .trim()
    .split(/[。！？?]/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length || sentences.length > 2) return;
  const [first, after] = sentences;
  // A city prompt can include example place names and a short description of
  // the weather report to follow. Other instructions or additional questions
  // must remain with the user.
  if (
    after &&
    !/^(?:我会|我将)(?:查询|提供|汇报)(?:今天的|明天的|当地的|该城市的)?天气(?:情况|预报)?(?:[，,]?(?:并|并且)?(?:提供|汇报)(?:气温|天气|降雨|风力|出行建议|温度)(?:(?:、|和|与)(?:气温|天气|降雨|风力|出行建议|温度))*)?$/u.test(
      after,
    )
  )
    return;
  const city = first.replace(
    /[，,]\s*(?:例如|比如)(?:[\p{Script=Han}]{2,6})(?:(?:、|或|和)(?:[\p{Script=Han}]{2,6}))*$/u,
    "",
  );
  if (
    /^(?:请问)?(?:你|您)?(?:想|需要)?(?:查询|查|查看)?(?:一下)?(?:哪个|哪座)城市(?:的天气)?(?:呢|吗)?$/u.test(
      city,
    ) ||
    /^请(?:告诉我|提供|指定)(?:你|您)?(?:想|需要)?(?:查询|查)?的?城市(?:名称)?$/u.test(
      city,
    ) ||
    /^which city(?: should i (?:check|look up))?$/i.test(city)
  )
    return "city";
  if (after) return;
  if (
    /^(?:(?:请问)?(?:希望|需要|请指定)?(?:使用|用)?(?:哪种|什么)语言(?:回答|输出|回复)?|which language should i (?:use|respond in))$/i.test(
      first,
    )
  )
    return "language";
  if (
    /^(?:(?:请问)?(?:需要|希望)?(?:使用|用)?(?:哪个|什么)时区|which time ?zone should i use)$/i.test(
      first,
    )
  )
    return "timezone";
}

export function isTextFollowup(text: string) {
  const value = text.trim();
  if (!value || value.length > 350 || sensitive.test(value)) return false;
  return (
    !!fieldOf(value) ||
    /^(?:请问|请告诉我|请提供|请指定|你希望|您希望|你想|您想|which |what |could you specify )[^。！？?\n]{1,120}[？?]$/i.test(
      value,
    )
  );
}

const labels: Record<Field, RegExp> = {
  city: /^(?:城市|city)\s*[:：=]\s*([\p{Script=Han}]{2,12}|[A-Za-z][A-Za-z -]{1,40})$/iu,
  language:
    /^(?:输出语言|回复语言|语言|language)\s*[:：=]\s*(中文|简体中文|繁体中文|英文|英语|日语|法语|德语|Spanish|English|Chinese|Japanese|French|German)$/i,
  timezone: /^(?:时区|timezone)\s*[:：=]\s*(UTC|[A-Za-z_]+\/[A-Za-z_]+)$/i,
};

export function explicitAnswer(
  question: string,
  original: string,
): string | undefined {
  const field = fieldOf(question);
  if (!field || sensitive.test(original) || conditional.test(original)) return;
  const values = new Set<string>();
  for (const clause of original.trim().split(/[\n，,；;。]/)) {
    const part = clause.trim();
    let value = labels[field].exec(part)?.[1];
    if (!value && field === "city") {
      const request = part
        .replace(
          /^(?:请)?(?:问(?:下|一下)?|让|请)\s*(?:codex|claude(?: code)?|pi|opencode)\s*/i,
          "",
        )
        .replace(/^(?:请)?(?:帮我)?(?:查一下|查下|查询|查)\s*/, "");
      value =
        /^([\p{Script=Han}]{2,10}?)(?:的)?(?:今天|今日|明天|本周)(?:的)?天气(?:情况|预报)?[？?]?$/u.exec(
          request,
        )?.[1] ?? /^这次查([\p{Script=Han}]{2,10})$/u.exec(part)?.[1];
    }
    if (value && field === "city" && relativePlace.test(value)) return;
    if (value) values.add(value);
  }
  return values.size === 1 ? [...values][0] : undefined;
}
