package expo.modules.guardnative

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.os.Build
import android.os.Bundle
import android.telephony.SmsManager
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.charset.Charset
import java.security.MessageDigest

/**
 * The three things the Guard App needs that no Expo module provides:
 *
 *  1. SOS without a tap (PRD 18.9 §9, rungs 5–7): send an SMS and place a call directly.
 *     Both need a runtime permission; without it the functions return false and the JS side
 *     falls back to the pre-filled composer / dialler, so the ladder never stalls.
 *  2. OTP auto-read (PRD 18.1, SUR-GAP-001) through the SMS Retriever API, which needs no SMS
 *     permission at all — the OTP message ends with this app's 11-character hash.
 *  3. NFC checkpoint scanning (PRD 18.7, SUR-GAP-014) in reader mode while the patrol screen is open.
 */
class GuardNativeModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var smsReceiver: BroadcastReceiver? = null
  private var nfcActivity: Activity? = null

  override fun definition() = ModuleDefinition {
    Name("GuardNative")

    Events("onSmsCode", "onSmsTimeout", "onNfcTag")

    // ---------------------------------------------------------------- SOS
    Function("hasPermission") { name: String ->
      val perm = when (name) {
        "sms" -> Manifest.permission.SEND_SMS
        "call" -> Manifest.permission.CALL_PHONE
        else -> return@Function false
      }
      ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
    }

    AsyncFunction("sendSmsDirect") { phone: String, body: String ->
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
        return@AsyncFunction false
      }
      try {
        val manager: SmsManager? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          context.getSystemService(SmsManager::class.java)
        } else {
          @Suppress("DEPRECATION")
          SmsManager.getDefault()
        }
        if (manager == null) return@AsyncFunction false
        val parts = manager.divideMessage(body)
        if (parts.size > 1) {
          manager.sendMultipartTextMessage(phone, null, parts, null, null)
        } else {
          manager.sendTextMessage(phone, null, body, null, null)
        }
        true
      } catch (e: Exception) {
        false
      }
    }

    AsyncFunction("placeCall") { phone: String ->
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
        return@AsyncFunction false
      }
      try {
        val intent = Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(phone)))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
      } catch (e: Exception) {
        false
      }
    }

    // ---------------------------------------------------------------- OTP auto-read
    /** The 11-character hash the server must append to the OTP SMS (GUARD_SMS_APP_HASH). */
    Function<String>("getAppHash") {
      appHash(context)
    }

    /** Listens for one OTP message for up to five minutes (the API's own limit). */
    AsyncFunction<Boolean>("startSmsListener") {
      stopSmsListener()
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
          if (intent?.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
          val extras: Bundle = intent.extras ?: return
          @Suppress("DEPRECATION")
          val status = extras.get(SmsRetriever.EXTRA_STATUS) as? Status ?: return
          when (status.statusCode) {
            CommonStatusCodes.SUCCESS -> {
              val message = extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE) ?: ""
              val code = Regex("\\b(\\d{6})\\b").find(message)?.groupValues?.get(1)
              if (code != null) sendEvent("onSmsCode", bundleOf("code" to code))
            }
            CommonStatusCodes.TIMEOUT -> sendEvent("onSmsTimeout", bundleOf())
          }
          stopSmsListener()
        }
      }
      ContextCompat.registerReceiver(
        context,
        receiver,
        IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
        SmsRetriever.SEND_PERMISSION,
        null,
        ContextCompat.RECEIVER_EXPORTED
      )
      smsReceiver = receiver
      SmsRetriever.getClient(context).startSmsRetriever()
      true
    }

    Function<Unit>("stopSmsListener") {
      stopSmsListener()
    }

    // ---------------------------------------------------------------- NFC
    Function<String>("nfcStatus") {
      val adapter = NfcAdapter.getDefaultAdapter(context)
      when {
        adapter == null -> "unsupported"
        !adapter.isEnabled -> "disabled"
        else -> "enabled"
      }
    }

    Function<Boolean>("openNfcSettings") {
      try {
        val intent = Intent(android.provider.Settings.ACTION_NFC_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
      } catch (e: Exception) {
        false
      }
    }

    /** Reader mode while the patrol screen is open: every tag tapped emits `onNfcTag`. */
    Function<Boolean>("startNfcScan") {
      val activity = appContext.currentActivity ?: return@Function false
      val adapter = NfcAdapter.getDefaultAdapter(context) ?: return@Function false
      if (!adapter.isEnabled) return@Function false
      val flags = NfcAdapter.FLAG_READER_NFC_A or
        NfcAdapter.FLAG_READER_NFC_B or
        NfcAdapter.FLAG_READER_NFC_F or
        NfcAdapter.FLAG_READER_NFC_V
      adapter.enableReaderMode(activity, { tag: Tag -> onTag(tag) }, flags, null)
      nfcActivity = activity
      true
    }

    Function<Unit>("stopNfcScan") {
      stopNfc()
    }

    // ---------------------------------------------------------------- face quality
    // The face model is not bundled in the APK (it added ~15 MB); Google Play services downloads
    // it once. Running the detector on a blank frame at start-up asks for that download early, so
    // the model is usually in place before the first selfie. Until it arrives detectFaces fails and
    // the app keeps the photo unchecked — the server's face match still runs.
    OnCreate {
      try {
        val detector = FaceDetection.getClient(FaceDetectorOptions.Builder().build())
        val blank = android.graphics.Bitmap.createBitmap(32, 32, android.graphics.Bitmap.Config.ARGB_8888)
        detector.process(InputImage.fromBitmap(blank, 0)).addOnCompleteListener { detector.close() }
      } catch (_: Exception) {
        /* no Play services: face checks simply report unchecked */
      }
    }

    /**
     * Faces in a captured photo (PRD 18.5 §5 / 18.1 §5): how many, how large, eyes open, head
     * turn. On-device and offline. Used to retake a bad selfie automatically — never to reject
     * attendance; identity matching is the server's job.
     */
    AsyncFunction("detectFaces") { uri: String, promise: Promise ->
      try {
        val image = InputImage.fromFilePath(context, Uri.parse(uri))
        val options = FaceDetectorOptions.Builder()
          .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
          .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
          .build()
        val detector = FaceDetection.getClient(options)
        detector.process(image)
          .addOnSuccessListener { faces ->
            val largest = faces.maxByOrNull { it.boundingBox.width() * it.boundingBox.height() }
            val area = (image.width * image.height).toDouble().coerceAtLeast(1.0)
            val result = mutableMapOf<String, Any?>(
              "count" to faces.size,
              "width" to image.width,
              "height" to image.height
            )
            if (largest != null) {
              val box = largest.boundingBox
              result["faceArea"] = (box.width() * box.height()) / area
              result["centerX"] = box.exactCenterX() / image.width
              result["centerY"] = box.exactCenterY() / image.height
              result["leftEyeOpen"] = largest.leftEyeOpenProbability?.toDouble()
              result["rightEyeOpen"] = largest.rightEyeOpenProbability?.toDouble()
              result["headYaw"] = largest.headEulerAngleY.toDouble()
              result["headPitch"] = largest.headEulerAngleX.toDouble()
            }
            detector.close()
            promise.resolve(result)
          }
          .addOnFailureListener { e ->
            detector.close()
            promise.reject("ERR_FACE_DETECTION", e.message, e)
          }
      } catch (e: Exception) {
        promise.reject("ERR_FACE_DETECTION", e.message, e)
      }
    }

    // ---------------------------------------------------------------- wake alarms
    Function<Boolean>("alarmsExact") {
      GuardAlarms.canScheduleExact(context)
    }

    Function("scheduleAlarm") { id: String, atMs: Double, title: String, body: String, url: String, timeoutMs: Double ->
      GuardAlarms.ensureChannel(context)
      GuardAlarms.schedule(context, id, atMs.toLong(), title, body, url, timeoutMs.toLong())
    }

    Function("cancelAlarm") { id: String ->
      GuardAlarms.cancel(context, id)
    }

    /** Silence a ringing alarm once the guard has answered. */
    Function("dismissAlarm") { id: String ->
      GuardAlarms.dismiss(context, id)
    }

    Function<List<String>>("scheduledAlarms") {
      GuardAlarms.scheduledIds(context)
    }

    /** While the wake prompt is open it must show over the lock screen and switch the screen on. */
    Function("showOverLockScreen") { on: Boolean ->
      val activity = appContext.currentActivity ?: return@Function false
      activity.runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          activity.setShowWhenLocked(on)
          activity.setTurnScreenOn(on)
        } else {
          @Suppress("DEPRECATION")
          val flags = android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
          if (on) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
        }
      }
      true
    }

    OnActivityEntersBackground {
      stopNfc()
    }

    OnDestroy {
      stopSmsListener()
      stopNfc()
    }
  }

  private fun onTag(tag: Tag) {
    val id = tag.id?.joinToString("") { "%02X".format(it) } ?: ""
    var text = ""
    try {
      val ndef = Ndef.get(tag)
      val message = ndef?.cachedNdefMessage
      val record = message?.records?.firstOrNull()
      if (record != null) text = decodeRecord(record)
    } catch (e: Exception) {
      // An unformatted or locked tag still has a usable id.
    }
    sendEvent("onNfcTag", bundleOf("id" to id, "text" to text))
  }

  /** NDEF Text (RTD_TEXT) or URI record → string; anything else → its raw payload as UTF-8. */
  private fun decodeRecord(record: NdefRecord): String {
    val payload = record.payload ?: return ""
    if (record.tnf == NdefRecord.TNF_WELL_KNOWN && record.type.contentEquals(NdefRecord.RTD_TEXT) && payload.isNotEmpty()) {
      val status = payload[0].toInt()
      val utf16 = (status and 0x80) != 0
      val langLength = status and 0x3F
      val charset = if (utf16) Charset.forName("UTF-16") else Charsets.UTF_8
      return String(payload, 1 + langLength, payload.size - 1 - langLength, charset)
    }
    if (record.tnf == NdefRecord.TNF_WELL_KNOWN && record.type.contentEquals(NdefRecord.RTD_URI)) {
      return record.toUri()?.toString() ?: ""
    }
    return String(payload, Charsets.UTF_8)
  }

  private fun stopSmsListener() {
    val r = smsReceiver ?: return
    try {
      context.unregisterReceiver(r)
    } catch (e: Exception) {
      // already unregistered
    }
    smsReceiver = null
  }

  private fun stopNfc() {
    val activity = nfcActivity ?: return
    try {
      NfcAdapter.getDefaultAdapter(activity)?.disableReaderMode(activity)
    } catch (e: Exception) {
      // activity already gone
    }
    nfcActivity = null
  }

  /** Google's documented app-hash algorithm for the SMS Retriever API. */
  private fun appHash(ctx: Context): String {
    return try {
      val pm = ctx.packageManager
      val pkg = ctx.packageName
      val signatures: List<String> = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
        info.signingInfo?.apkContentsSigners?.map { it.toCharsString() } ?: emptyList()
      } else {
        @Suppress("DEPRECATION")
        val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES)
        @Suppress("DEPRECATION")
        info.signatures?.map { it.toCharsString() } ?: emptyList()
      }
      val sig = signatures.firstOrNull() ?: return ""
      val digest = MessageDigest.getInstance("SHA-256")
      digest.update("$pkg $sig".toByteArray(Charsets.UTF_8))
      val hash = digest.digest().copyOfRange(0, 9)
      Base64.encodeToString(hash, Base64.NO_PADDING or Base64.NO_WRAP).substring(0, 11)
    } catch (e: Exception) {
      ""
    }
  }
}
