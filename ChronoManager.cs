using UnityEngine;
using TMPro;

public class ChronoManager : MonoBehaviour
{
    [Header("Glisser le texte d'affichage ici")]
    public TextMeshProUGUI texteTemps;

    private float tempsEcoule = 0f;
    private bool enMarche = false;

    void Update()
    {
        if (!enMarche) return;
        tempsEcoule += Time.deltaTime;
        AfficherTemps();
    }

    // Appelé par le bouton DÉMARRER
    public void Demarrer()
    {
        enMarche = true;
    }

    // Appelé par le bouton ARRÊTER
    public void Arreter()
    {
        enMarche = false;
    }

    // Appelé par le bouton RÉINITIALISER (optionnel)
    public void Reinitialiser()
    {
        enMarche = false;
        tempsEcoule = 0f;
        AfficherTemps();
    }

    void AfficherTemps()
    {
        if (texteTemps == null) return;
        int min = (int)(tempsEcoule / 60f);
        int sec = (int)(tempsEcoule % 60f);
        int cen = (int)((tempsEcoule * 100f) % 100f);
        texteTemps.text = string.Format("{0:00}:{1:00}:{2:00}", min, sec, cen);
    }
}
