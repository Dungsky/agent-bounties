//! Public, read-only discovery. Keep coverage metadata intact for callers.
use anyhow::{ensure, Result};
use clap::Args;
use serde_json::Value;

#[derive(Debug, Args)]
pub struct OpportunityArgs {
    #[arg(long, default_value = "https://api.agentizable.ai")]
    api_base_url: String,
    #[arg(long, default_value = "base-mainnet", value_parser = ["base-mainnet", "base-sepolia"])]
    network: String,
    #[arg(long, default_value = "ready_to_earn", value_parser = ["ready_to_earn", "recent", "engineering", "creative", "urgent", "seeking_funding"])]
    view: String,
    #[arg(long)]
    opportunity_id: Option<String>,
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u16).range(1..=300))]
    limit: u16,
}

fn coverage_notice(value: &Value) -> Option<&'static str> {
    if value["has_more"] == true {
        return Some("Showing a limited page of checked listings; the full count is unknown.");
    }
    match value.get("coverage").and_then(Value::as_str) {
        Some("complete") => None,
        Some("partial") => Some("Showing checked listings. Coverage is partial; the full count is unknown."),
        Some("unavailable") => Some("Listings are unavailable. The number of bounties is unknown, not zero."),
        _ => Some("Coverage is unspecified. Inspect source_statuses before acting; do not infer a market total."),
    }
}

pub async fn run(args: OpportunityArgs) -> Result<()> {
    let base = reqwest::Url::parse(&args.api_base_url)?;
    ensure!(
        base.username().is_empty()
            && base.password().is_none()
            && base.query().is_none()
            && base.fragment().is_none(),
        "invalid API URL"
    );
    ensure!(
        base.scheme() == "https"
            || (base.scheme() == "http"
                && matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))),
        "Use HTTPS except for local tests"
    );
    let mut url = base.join("/v1/opportunities")?;
    url.query_pairs_mut()
        .append_pair("network", &args.network)
        .append_pair("view", &args.view)
        .append_pair("source_type", "canonical_base")
        .append_pair("limit", &args.limit.to_string());
    if let Some(id) = args.opportunity_id {
        url.query_pairs_mut().append_pair("opportunity_id", &id);
    }
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60))
        .build()?
        .get(url)
        .header("x-agent-bounties-interface", "cli")
        .send()
        .await?
        .error_for_status()?;
    let value: Value = response.json().await?;
    ensure!(
        value["schema_version"] == "agent-bounties/opportunity-projection-v1"
            && value["items"].is_array(),
        "Unsupported opportunity projection"
    );
    if let Some(notice) = coverage_notice(&value) {
        eprintln!("{notice}");
    }
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn partial_and_unavailable_notices_do_not_claim_zero() {
        assert!(
            coverage_notice(&json!({"coverage":"partial", "items":[{"title":"Healthy"}]}))
                .unwrap()
                .contains("full count is unknown")
        );
        assert!(
            coverage_notice(&json!({"coverage":"unavailable", "items":[]}))
                .unwrap()
                .contains("not zero")
        );
        assert!(coverage_notice(&json!({"coverage":"complete", "items":[]})).is_none());
        assert!(coverage_notice(&json!({"items":[]})).is_some());
    }
}
