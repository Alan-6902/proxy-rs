//! 计费事件
//!
//! 处理 meteringEvent 类型的事件

use serde::Deserialize;

use crate::kiro::parser::error::ParseResult;
use crate::kiro::parser::frame::Frame;

use super::base::EventPayload;

/// 上游按 credit 计费时的单位名
///
/// 只认这个值才累加：`usage` 的语义完全由 `unit` 决定，换成别的单位（比如按
/// 请求数或 token 计）时同一个数字不能直接当积分加进去。
pub const METERING_UNIT_CREDIT: &str = "credit";

/// 计费事件
///
/// 上游在每次请求的流里下发本次实际扣减量，形如：
/// `{"unit":"credit","unitPlural":"credits","usage":0.017364763582089555}`
///
/// 这是「我消耗了多少积分」唯一可信的来源。与 `/balance` 的账号累计额度不同：
/// 账号额度是该号的总消耗，抢来的号被原主或其他反代同时使用时也会涨，靠它做
/// 差分会把别人的消耗算到自己头上（实测偏高约 32 倍）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeteringEvent {
    /// 计费单位，实测为 "credit"
    #[serde(default)]
    pub unit: String,
    /// 计费单位的复数形式，实测为 "credits"
    #[serde(default)]
    pub unit_plural: String,
    /// 本次请求的扣减量，单位由 `unit` 决定。上游给完整浮点，不要取整
    #[serde(default)]
    pub usage: f64,
}

impl EventPayload for MeteringEvent {
    fn from_frame(frame: &Frame) -> ParseResult<Self> {
        frame.payload_as_json()
    }
}

impl MeteringEvent {
    /// 本次可计入积分的扣减量
    ///
    /// 返回 None 表示不该记账：单位不是 credit（语义对不上），或者数值不是
    /// 有限正数（NaN 会污染整份累计，负值与 0 没有意义）。
    pub fn credit_usage(&self) -> Option<f64> {
        if self.unit != METERING_UNIT_CREDIT {
            return None;
        }
        if !self.usage.is_finite() || self.usage <= 0.0 {
            return None;
        }
        Some(self.usage)
    }
}

impl std::fmt::Display for MeteringEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.usage, self.unit_plural)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> MeteringEvent {
        serde_json::from_str(json).expect("payload 应能解析")
    }

    #[test]
    fn test_parses_real_upstream_payload() {
        // 实测抓取的原文，字段名与精度照抄，不要改成整数
        let event =
            parse(r#"{"unit":"credit","unitPlural":"credits","usage":0.017364763582089555}"#);
        assert_eq!(event.unit, "credit");
        assert_eq!(event.unit_plural, "credits");
        assert_eq!(event.credit_usage(), Some(0.017364763582089555));
    }

    #[test]
    fn test_rejects_non_credit_unit() {
        // 单位换了，同一个数字就不是积分了，不能累加
        let event = parse(r#"{"unit":"request","unitPlural":"requests","usage":1.0}"#);
        assert_eq!(event.credit_usage(), None);
    }

    #[test]
    fn test_rejects_non_positive_and_non_finite() {
        assert_eq!(parse(r#"{"unit":"credit","usage":0}"#).credit_usage(), None);
        assert_eq!(parse(r#"{"unit":"credit","usage":-1.5}"#).credit_usage(), None);
        // NaN / Infinity 不是合法 JSON 数值，只能构造出来验证防御
        let nan = MeteringEvent {
            unit: METERING_UNIT_CREDIT.to_string(),
            unit_plural: "credits".to_string(),
            usage: f64::NAN,
        };
        assert_eq!(nan.credit_usage(), None);
        let inf = MeteringEvent {
            unit: METERING_UNIT_CREDIT.to_string(),
            unit_plural: "credits".to_string(),
            usage: f64::INFINITY,
        };
        assert_eq!(inf.credit_usage(), None);
    }

    #[test]
    fn test_missing_fields_default_to_skip() {
        // 字段缺失时不该 panic，也不该记账
        assert_eq!(parse("{}").credit_usage(), None);
    }
}
