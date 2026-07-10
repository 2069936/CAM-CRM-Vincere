import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import ChangePassword from "./ChangePassword";

// The signed-in user's own profile: their basic info (read-only) plus a
// self-service password change. Email comes from the Supabase Auth session
// (not carried on the app session object).
export default function ProfilePanel({ session }) {
  const [email, setEmail] = useState("");

  useEffect(() => {
    let active = true;
    if (supabase) {
      supabase.auth
        .getUser()
        .then(({ data }) => {
          if (active) setEmail(data?.user?.email || "");
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, []);

  const name = session?.displayName || session?.username || "—";

  return (
    <div className="profile-panel">
      <h2>My Profile</h2>
      <dl className="profile-fields">
        <div>
          <dt>Name</dt>
          <dd>{name}</dd>
        </div>
        <div>
          <dt>Username</dt>
          <dd>{session?.username || "—"}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{email || "—"}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{session?.role || "—"}</dd>
        </div>
      </dl>
      <div className="profile-password">
        <h3>Change password</h3>
        <ChangePassword />
      </div>
    </div>
  );
}
