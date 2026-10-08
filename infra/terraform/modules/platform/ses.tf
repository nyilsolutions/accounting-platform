# Amazon SES (MAIL_TRANSPORT=ses): the sending domain with Easy DKIM, a custom MAIL FROM domain
# (SPF alignment), and a configuration set that keeps the account's suppression list for bounces
# and complaints and reports delivery problems to the alarm topic. New accounts start in the SES
# sandbox; production access is requested once (launch checklist).

resource "aws_sesv2_configuration_set" "main" {
  configuration_set_name = local.prefix
  delivery_options {
    tls_policy = "REQUIRE"
  }
  reputation_options {
    reputation_metrics_enabled = true
  }
  sending_options {
    sending_enabled = true
  }
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
  tags = local.tags
}

resource "aws_sesv2_email_identity" "mail" {
  email_identity         = var.mail_domain
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
  tags = local.tags
}

resource "aws_sesv2_email_identity_mail_from_attributes" "mail" {
  email_identity         = aws_sesv2_email_identity.mail.email_identity
  mail_from_domain       = "bounce.${var.mail_domain}"
  behavior_on_mx_failure = "REJECT_MESSAGE"
}

resource "aws_sesv2_configuration_set_event_destination" "problems" {
  configuration_set_name = aws_sesv2_configuration_set.main.configuration_set_name
  event_destination_name = "delivery-problems"
  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT", "RENDERING_FAILURE"]
    sns_destination {
      topic_arn = aws_sns_topic.mail_events.arn
    }
  }
}

# DNS: DKIM, MAIL FROM (MX and SPF) and DMARC, when the zone is ours.
resource "aws_route53_record" "dkim" {
  count   = var.route53_zone_id == null ? 0 : 3
  zone_id = var.route53_zone_id
  name    = "${aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.mail_domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "mail_from_mx" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = aws_sesv2_email_identity_mail_from_attributes.mail.mail_from_domain
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.${local.region}.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = aws_sesv2_email_identity_mail_from_attributes.mail.mail_from_domain
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com -all"]
}

resource "aws_route53_record" "dmarc" {
  count   = var.route53_zone_id == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = "_dmarc.${var.mail_domain}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=DMARC1; p=quarantine; adkim=s; aspf=r; pct=100"]
}
