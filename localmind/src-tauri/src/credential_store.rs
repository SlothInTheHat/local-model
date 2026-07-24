//! Secret storage via the Windows Credential Manager — used to keep
//! provider API keys (src/store/providers.ts) and MCP server tokens
//! (src/store/mcp.ts's per-server `env`) out of the webview's plain
//! localStorage, where anything with disk/process access to the app's
//! profile directory could read them in cleartext. Values are namespaced
//! under a `LocalMind/<service>/<account>` target name so this app's entries
//! don't collide with (or get confused for) any other app's saved
//! credentials in the same OS-wide store.
//!
//! Windows-only, following the same pattern as the rest of this codebase
//! (window control, screenshot/OCR, UI Automation): other targets get a
//! runtime "unsupported" Err rather than failing to compile. On those
//! targets the frontend (src/lib/credentials.ts) falls back to keeping
//! secrets in memory only for the session, rather than ever writing them to
//! localStorage — strictly more secure than the prior behavior everywhere,
//! even where the OS vault itself isn't available.

#[tauri::command]
pub fn cred_set(service: String, account: String, secret: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::set(&service, &account, &secret)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (service, account, secret);
        Err("Credential storage is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn cred_get(service: String, account: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(windows_impl::get(&service, &account))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (service, account);
        Err("Credential storage is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn cred_delete(service: String, account: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::delete(&service, &account);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (service, account);
        Err("Credential storage is only supported on Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn target_name(service: &str, account: &str) -> HSTRING {
        HSTRING::from(format!("LocalMind/{service}/{account}"))
    }

    pub fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
        let target = target_name(service, account);
        // TargetName must be a mutable wide-string pointer for the duration of
        // the call — build our own null-terminated buffer rather than reusing
        // the HSTRING's internal (immutable) pointer.
        let mut target_wide: Vec<u16> = target.to_string().encode_utf16().chain(std::iter::once(0)).collect();
        let mut blob = secret.as_bytes().to_vec();

        let mut cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target_wide.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };

        unsafe { CredWriteW(&cred, 0) }.map_err(|e| format!("Failed to save credential: {e}"))?;
        // Keep both buffers alive until after the call above.
        let _ = (&mut target_wide, &mut blob, &mut cred);
        Ok(())
    }

    /// Any failure (not found, or otherwise) is folded into `None` — the only
    /// realistic failure mode for a read is "this credential was never set,"
    /// and treating that the same as a transient error just means the caller
    /// sees "no key configured yet," which is always a safe outcome here.
    pub fn get(service: &str, account: &str) -> Option<String> {
        let target = target_name(service, account);
        let mut p_cred: *mut CREDENTIALW = std::ptr::null_mut();
        let result = unsafe { CredReadW(&target, CRED_TYPE_GENERIC, None, &mut p_cred) };
        if result.is_err() || p_cred.is_null() {
            return None;
        }
        let secret = unsafe {
            let cred = &*p_cred;
            let blob = std::slice::from_raw_parts(cred.CredentialBlob, cred.CredentialBlobSize as usize);
            let value = String::from_utf8_lossy(blob).to_string();
            CredFree(p_cred as *const core::ffi::c_void);
            value
        };
        Some(secret)
    }

    /// No-op (not an error) if the credential was never set — deleting
    /// something that isn't there isn't a failure from the caller's
    /// perspective (e.g. clearing a provider's key it never had).
    pub fn delete(service: &str, account: &str) {
        let target = target_name(service, account);
        let _ = unsafe { CredDeleteW(&target, CRED_TYPE_GENERIC, None) };
    }
}
