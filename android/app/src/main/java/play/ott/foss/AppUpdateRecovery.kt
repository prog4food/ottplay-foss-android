package play.ott.foss

/** Explicit retry only. This never opens a prompt or runs from status/startup. */
internal object AppUpdateRecovery {
    data class Session(val installerPackage: String?, val targetPackage: String?)

    fun retry(
        recordedId: Int,
        packageName: String,
        verifyStage: () -> Unit,
        findSession: (Int) -> Session?,
        invalidateSession: () -> Unit,
        abandonSession: (Int) -> Unit
    ) {
        require(recordedId >= 0)
        // Hash, installed signer and strictly newer version must all pass before
        // touching an existing session, even when Android already removed it.
        verifyStage()
        val session = findSession(recordedId)
        if (session != null) {
            require(session.installerPackage == packageName && session.targetPackage == packageName)
        }
        // Abandonment may deliver a failure callback immediately. Retire its
        // identity before cleanup so it cannot overwrite the replacement state.
        invalidateSession()
        if (session == null) return
        // Failure must propagate; creating another session after failed cleanup
        // could leave two competing confirmation prompts.
        abandonSession(recordedId)
    }
}
