export type SendMailParams = {
  to: string;
  subject: string;
  text: string;
};

function isProd() {
  return process.env.NODE_ENV === "production";
}

/**
 * Placeholder mailer.
 *
 * Replace with a real provider (Resend/SendGrid/SES/Nodemailer) and keep this
 * interface stable for routes.
 */
export async function sendMail(params: SendMailParams): Promise<void> {
  const { to, subject, text } = params;

  if (isProd()) {
    console.warn("[mailer] sendMail called but no provider configured", { to, subject });
    return;
  }

  console.log("\n--- DEV EMAIL ---");
  console.log("To:", to);
  console.log("Subject:", subject);
  console.log(text);
  console.log("--- END DEV EMAIL ---\n");
}
