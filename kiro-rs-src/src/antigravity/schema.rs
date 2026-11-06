//! 工具入参 JSON Schema 清洗：Gemini functionDeclarations 只接受 OpenAPI 子集
//!
//! 处理顺序：先内联本地 `$ref`，再逐层把校验类关键字挪进 description、
//! 合并 anyOf/oneOf/allOf 分支、删除不支持的关键字、把 type 收敛成单个小写字符串。

use serde_json::{Map, Value, json};

/// `$ref` 最多展开几层，防止自引用 schema 无限递归
const MAX_REF_DEPTH: usize = 8;

/// 挪进 description 的校验关键字：(关键字, 展示标签)
const CONSTRAINT_FIELDS: &[(&str, &str)] = &[
    ("pattern", "pattern"),
    ("minLength", "minLen"),
    ("maxLength", "maxLen"),
    ("minimum", "min"),
    ("maximum", "max"),
    ("minItems", "minItems"),
    ("maxItems", "maxItems"),
    ("exclusiveMinimum", "exclMin"),
    ("exclusiveMaximum", "exclMax"),
    ("multipleOf", "multipleOf"),
    ("format", "format"),
];

/// 上游直接报 400 的关键字
const REMOVED_FIELDS: &[&str] = &[
    "$schema",
    "$id",
    "$defs",
    "definitions",
    "additionalProperties",
    "enumCaseInsensitive",
    "enumNormalizeWhitespace",
    "uniqueItems",
    "default",
    "examples",
    "propertyNames",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "dependencies",
    "dependentSchemas",
    "dependentRequired",
    "cache_control",
    "tools",
];

const BRANCH_KEYWORDS: &[&str] = &["anyOf", "oneOf"];
const TYPE_OBJECT: &str = "object";
const TYPE_ARRAY: &str = "array";
const TYPE_STRING: &str = "string";
const TYPE_NULL: &str = "null";

/// 把工具的 input_schema 清洗成 Gemini 可接受的 parameters
pub fn clean_tool_schema(schema: &Map<String, Value>) -> Value {
    let root = Value::Object(schema.clone());
    let defs = collect_defs(&root);
    let mut out = resolve_refs(&root, &defs, 0);
    clean_recursive(&mut out);
    if let Value::Object(map) = &mut out {
        if !map.get("type").is_some_and(Value::is_string) {
            map.insert("type".into(), json!(TYPE_OBJECT));
        }
        if map.get("type").and_then(Value::as_str) == Some(TYPE_OBJECT)
            && !map.get("properties").is_some_and(Value::is_object)
        {
            map.insert("properties".into(), json!({}));
        }
        out
    } else {
        json!({ "type": TYPE_OBJECT, "properties": {} })
    }
}

fn collect_defs(root: &Value) -> Map<String, Value> {
    let mut defs = Map::new();
    for key in ["$defs", "definitions"] {
        if let Some(Value::Object(m)) = root.get(key) {
            for (k, v) in m {
                defs.insert(format!("#/{key}/{k}"), v.clone());
            }
        }
    }
    defs
}

/// 内联本地 `$ref`；解析不了或超过深度的引用退化成宽松的 object
fn resolve_refs(value: &Value, defs: &Map<String, Value>, depth: usize) -> Value {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(r)) = map.get("$ref") {
                let target = defs.get(r).filter(|_| depth < MAX_REF_DEPTH);
                let mut resolved = match target {
                    Some(t) => resolve_refs(t, defs, depth + 1),
                    None => json!({ "type": TYPE_OBJECT }),
                };
                // $ref 旁边的 description 等兄弟字段保留
                if let Value::Object(rm) = &mut resolved {
                    for (k, v) in map {
                        if k != "$ref" && !rm.contains_key(k) {
                            rm.insert(k.clone(), resolve_refs(v, defs, depth));
                        }
                    }
                }
                return resolved;
            }
            Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), resolve_refs(v, defs, depth)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(|v| resolve_refs(v, defs, depth)).collect()),
        other => other.clone(),
    }
}

fn is_primitive(v: &Value) -> bool {
    v.is_string() || v.is_number() || v.is_boolean()
}

fn primitive_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn infer_type(v: &Value) -> Option<&'static str> {
    match v {
        Value::String(_) => Some(TYPE_STRING),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some("integer"),
        Value::Number(_) => Some("number"),
        Value::Bool(_) => Some("boolean"),
        Value::Array(_) => Some(TYPE_ARRAY),
        Value::Object(_) => Some(TYPE_OBJECT),
        Value::Null => None,
    }
}

/// 分支合并：只补缺失字段，properties 逐个补、required 取并集
fn merge_into(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, val) in source {
        match (key.as_str(), val) {
            ("properties", Value::Object(props)) => {
                let entry = target
                    .entry("properties")
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Value::Object(tp) = entry {
                    for (k, v) in props {
                        tp.entry(k.clone()).or_insert_with(|| v.clone());
                    }
                }
            }
            ("required", Value::Array(req)) => {
                let mut merged: Vec<Value> = target
                    .get("required")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for r in req {
                    if !merged.contains(r) {
                        merged.push(r.clone());
                    }
                }
                target.insert("required".into(), Value::Array(merged));
            }
            _ => {
                target.entry(key.clone()).or_insert_with(|| val.clone());
            }
        }
    }
}

fn collapse_branches(map: &mut Map<String, Value>) {
    if let Some(Value::Array(all)) = map.get("allOf").cloned() {
        for branch in all.iter().filter_map(Value::as_object) {
            merge_into(map, branch);
        }
    }
    for kw in BRANCH_KEYWORDS {
        if let Some(Value::Array(branches)) = map.get(*kw).cloned() {
            // 取第一个有实际形状的分支（跳过 {type: null} 这类可空标记）
            let usable = branches.iter().filter_map(Value::as_object).find(|b| {
                b.contains_key("properties")
                    || b.get("type").is_some_and(|t| t.as_str() != Some(TYPE_NULL))
            });
            if let Some(b) = usable {
                merge_into(map, b);
            }
        }
    }
}

fn clean_recursive(value: &mut Value) {
    let map = match value {
        Value::Object(m) => m,
        Value::Array(items) => {
            items.iter_mut().for_each(clean_recursive);
            return;
        }
        _ => return,
    };

    // const → enum
    let had_const = if let Some(c) = map.remove("const") {
        if !map.contains_key("type")
            && let Some(t) = infer_type(&c) {
                map.insert("type".into(), json!(t));
            }
        let mut values = map.get("enum").and_then(Value::as_array).cloned().unwrap_or_default();
        if !values.contains(&c) {
            values.push(c);
        }
        map.insert("enum".into(), Value::Array(values));
        true
    } else {
        false
    };

    // 非对象的 property 删除，并同步 required
    if let Some(Value::Object(props)) = map.get_mut("properties") {
        let dropped: Vec<String> = props
            .iter()
            .filter(|(_, v)| !v.is_object())
            .map(|(k, _)| k.clone())
            .collect();
        for k in &dropped {
            props.remove(k);
        }
        if !dropped.is_empty()
            && let Some(Value::Array(req)) = map.get_mut("required") {
                req.retain(|r| !r.as_str().is_some_and(|s| dropped.iter().any(|d| d == s)));
                if req.is_empty() {
                    map.remove("required");
                }
            }
    }
    if map.get("items").is_some_and(|v| !v.is_object()) {
        map.remove("items");
    }

    if let Some(Value::Object(props)) = map.get_mut("properties") {
        props.values_mut().for_each(clean_recursive);
    }
    if let Some(items) = map.get_mut("items") {
        clean_recursive(items);
    }
    for kw in ["allOf", "anyOf", "oneOf"] {
        if let Some(v) = map.get_mut(kw) {
            clean_recursive(v);
        }
    }

    let mut constraints: Vec<String> = Vec::new();

    if let Some(values) = map.get("enum").cloned() {
        match values {
            Value::Array(values) => {
                let values: Vec<Value> = if had_const {
                    values.iter().map(|v| json!(primitive_to_string(v))).collect()
                } else {
                    values
                };
                let prims: Vec<&Value> = values.iter().filter(|v| is_primitive(v)).collect();
                let ty = map.get("type").and_then(Value::as_str).unwrap_or_default().to_lowercase();
                if prims.is_empty() {
                    map.remove("enum");
                } else if matches!(ty.as_str(), "string" | "integer" | "number") {
                    map.insert(
                        "enum".into(),
                        Value::Array(prims.iter().map(|v| json!(primitive_to_string(v))).collect()),
                    );
                } else if prims.iter().all(|v| v.is_string()) {
                    map.insert("enum".into(), Value::Array(prims.into_iter().cloned().collect()));
                } else {
                    let joined: Vec<String> = prims.iter().map(|v| primitive_to_string(v)).collect();
                    constraints.push(format!("enum: {}", joined.join(", ")));
                    map.remove("enum");
                }
            }
            _ => {
                map.remove("enum");
            }
        }
    }

    for (field, label) in CONSTRAINT_FIELDS {
        if map.get(*field).is_some_and(is_primitive) {
            let v = map.remove(*field).unwrap_or_default();
            constraints.push(format!("{label}: {}", primitive_to_string(&v)));
        }
    }
    if !constraints.is_empty() {
        let desc = map.get("description").and_then(Value::as_str).unwrap_or_default();
        let suffix = format!(" [Constraint: {}]", constraints.join(", "));
        map.insert("description".into(), json!(format!("{desc}{suffix}")));
    }

    collapse_branches(map);

    for field in REMOVED_FIELDS {
        map.remove(*field);
    }

    // type 收敛成单个小写字符串；联合类型取第一个非 null
    if let Some(t) = map.get("type").cloned() {
        let normalized = match t {
            Value::String(s) => Some(s.to_lowercase()),
            Value::Array(list) => Some(
                list.iter()
                    .filter_map(Value::as_str)
                    .find(|s| *s != TYPE_NULL)
                    .unwrap_or(TYPE_STRING)
                    .to_lowercase(),
            ),
            _ => None,
        };
        match normalized {
            Some(s) => {
                map.insert("type".into(), json!(s));
            }
            None => {
                map.remove("type");
            }
        }
    }

    if map.get("type").and_then(Value::as_str) == Some(TYPE_ARRAY) && !map.contains_key("items") {
        map.insert("items".into(), json!({ "type": TYPE_STRING }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(v: Value) -> Value {
        clean_tool_schema(v.as_object().unwrap())
    }

    #[test]
    fn moves_constraints_and_removes_unsupported_keys() {
        let out = clean(json!({
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "path": { "type": "string", "minLength": 1, "description": "file", "default": "a" },
                "n": { "type": ["integer", "null"], "maximum": 5 },
                "tags": { "type": "ARRAY" },
                "junk": true
            },
            "required": ["path", "junk"]
        }));
        assert_eq!(out["properties"]["path"]["description"], "file [Constraint: minLen: 1]");
        assert!(out["properties"]["path"].get("default").is_none());
        assert_eq!(out["properties"]["n"]["type"], "integer");
        assert_eq!(out["properties"]["tags"]["items"]["type"], "string");
        assert!(out["properties"].get("junk").is_none());
        assert_eq!(out["required"], json!(["path"]));
        assert!(out.get("$schema").is_none());
        assert!(out.get("additionalProperties").is_none());
    }

    #[test]
    fn const_becomes_enum_and_any_of_collapses() {
        let out = clean(json!({
            "type": "object",
            "properties": {
                "mode": { "const": "fast" },
                "target": { "anyOf": [{ "type": "null" }, { "type": "string", "description": "t" }] }
            }
        }));
        assert_eq!(out["properties"]["mode"], json!({ "type": "string", "enum": ["fast"] }));
        assert_eq!(out["properties"]["target"], json!({ "type": "string", "description": "t" }));
    }

    #[test]
    fn inlines_local_refs_and_bounds_recursion() {
        let out = clean(json!({
            "type": "object",
            "$defs": { "Node": { "type": "object", "properties": { "next": { "$ref": "#/$defs/Node" } } } },
            "properties": { "head": { "$ref": "#/$defs/Node", "description": "h" } }
        }));
        assert!(out.get("$defs").is_none());
        assert_eq!(out["properties"]["head"]["description"], "h");
        assert_eq!(out["properties"]["head"]["properties"]["next"]["type"], "object");
        assert!(!out.to_string().contains("$ref"));
    }

    #[test]
    fn empty_schema_becomes_empty_object() {
        assert_eq!(clean(json!({})), json!({ "type": "object", "properties": {} }));
    }
}
